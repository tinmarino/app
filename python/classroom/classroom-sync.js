/* classroom-sync.js — student login and S3 submission sync, via Cognito.
 *
 * There is NO secret in this file. The three identifiers below are public by
 * design: they are useless without a student password, the identity pool
 * refuses unauthenticated access, and the IAM role behind it can only touch
 * the student's own prefix. This replaces the previous scheme, which shipped
 * real AWS credentials encrypted under a shared password — see
 * doc: never put a long-lived AWS credential in a browser again.
 *
 * Flow:
 *   InitiateAuth(USER_PASSWORD_AUTH)  -> IdToken       (Cognito user pool)
 *   GetId + GetCredentialsForIdentity -> STS creds ~1h (Cognito identity pool)
 *   SigV4-signed S3 requests with x-amz-security-token
 *
 * Layout in the bucket, one object per submission so the history is kept:
 *   <identityId>/latest-class-01.json               the state to restore from
 *   <identityId>/submissions/<iso>-<exercise>.json  an append-only trail
 *
 * The identityId is stable per *username*, not per browser, which is what
 * makes "log in as tin on the phone" find the work done on the laptop.
 */
(function (global) {
  'use strict';

  const REGION           = 'us-east-1';
  const USER_POOL_ID     = 'us-east-1_c9FQsy3Bh';
  const CLIENT_ID        = '561nnmbcf87pdkbjj2jjqnnff1';
  const IDENTITY_POOL_ID = 'us-east-1:60c59179-712c-4d75-8397-c5ff916040e0';
  const BUCKET           = 'python-exercices';
  // Per-class state file, so a second class can add latest-class-02.json later.
  const LATEST_KEY       = 'latest-class-01.json';

  const IDP_HOST      = 'cognito-idp.' + REGION + '.amazonaws.com';
  const IDENTITY_HOST = 'cognito-identity.' + REGION + '.amazonaws.com';
  const S3_HOST       = BUCKET + '.s3.' + REGION + '.amazonaws.com';
  const PROVIDER      = IDP_HOST + '/' + USER_POOL_ID;

  // The refresh token stays in localStorage and the STS credentials stay only in
  // memory. The user also asked for a convenience cookie keeping the login name
  // and password so the page can sign back in automatically after a long pause.
  // That cookie is for speed, not for secrecy.
  //
  // SECURITY NOTE — the password is stored in CLEARTEXT in a JS-readable cookie.
  // This is strictly weaker than the refresh-token-only scheme it replaces: any
  // XSS on the /app/python/classroom/ path can exfiltrate it, and students who
  // reuse passwords across sites are exposed. It is acceptable here only because
  // the passwords are teacher-assigned throwaway credentials scoped to this
  // classroom, and the cookie is SameSite=Lax, path-restricted, and Secure on
  // HTTPS. If the app ever handles real credentials, replace this with a
  // refresh-token cookie or a server-side session.
  const STORE_KEY = 'py_classroom_session';
  const LOGIN_COOKIE = 'py_classroom_login';
  const LOGIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

  let session = null;   // { username, refreshToken }
  let creds = null;     // { AccessKeyId, SecretKey, SessionToken, expiresAt }
  let identityId = null;

  function cookieAttrs(maxAge) {
    let attrs = 'path=/app/python/classroom/; samesite=lax';
    if (typeof maxAge === 'number') attrs += '; max-age=' + maxAge;
    if (location.protocol === 'https:') attrs += '; secure';
    return attrs;
  }

  function rememberLogin(username, password) {
    const payload = encodeURIComponent(JSON.stringify({ username, password }));
    document.cookie = LOGIN_COOKIE + '=' + payload + '; ' + cookieAttrs(LOGIN_COOKIE_MAX_AGE);
  }

  function rememberedLogin() {
    const pattern = new RegExp('(?:^|; )' + LOGIN_COOKIE + '=([^;]*)');
    const found = document.cookie.match(pattern);
    if (!found) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(found[1]));
      if (!parsed || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function forgetRememberedLogin() {
    document.cookie = LOGIN_COOKIE + '=; ' + cookieAttrs(0);
  }

  // ---------------------------------------------------------------- Cognito

  async function cognito(host, target, body) {
    const resp = await fetch('https://' + host + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': target
      },
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(friendly(data));
      err.type = data.__type || '';
      err.data = data;
      throw err;
    }
    return data;
  }

  // Cognito's messages are usable, but a couple deserve plain language
  function friendly(data) {
    const type = (data.__type || '').split('#').pop();
    const message = data.message || type || 'Cognito request failed';
    if (type === 'NotAuthorizedException') return 'Wrong user name or password.';
    if (type === 'UserNotFoundException') return 'No such student. Ask your teacher to create the account.';
    if (type === 'PasswordResetRequiredException') return 'Your password must be reset. Ask your teacher.';
    if (type === 'TooManyRequestsException') return 'Too many attempts. Wait a moment and try again.';
    if (type === 'InvalidPasswordException') return 'That password is too weak: ' + message;
    if (type === 'UserLambdaValidationException' && /class password/i.test(message)) {
      return 'Wrong class password.';
    }
    if (type === 'InvalidParameterException' && /username/i.test(message)) {
      return 'User name: letters, digits, dots, dashes or underscores only.';
    }
    return message;
  }

  function saveSession() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(session)); }
    catch { /* private mode: the student will log in again next visit */ }
  }

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch { session = null; }
    return session;
  }

  // Turn an IdToken into STS credentials for this student
  async function exchangeForCredentials(idToken) {
    const logins = {};
    logins[PROVIDER] = idToken;

    const id = await cognito(IDENTITY_HOST, 'AWSCognitoIdentityService.GetId',
      { IdentityPoolId: IDENTITY_POOL_ID, Logins: logins });
    identityId = id.IdentityId;

    const got = await cognito(IDENTITY_HOST, 'AWSCognitoIdentityService.GetCredentialsForIdentity',
      { IdentityId: identityId, Logins: logins });
    const c = got.Credentials;
    creds = {
      AccessKeyId: c.AccessKeyId,
      SecretKey: c.SecretKey,
      SessionToken: c.SessionToken,
      // Expiration comes back as epoch seconds; renew a minute early
      expiresAt: (c.Expiration * 1000) - 60000
    };
    return creds;
  }

  // Log in with a name and the class password.
  // Resolves { status: 'ok' } or { status: 'new-password-required', session }
  async function login(username, password) {
    const auth = await cognito(IDP_HOST, 'AWSCognitoIdentityProviderService.InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password }
    });

    if (auth.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      // The account was created with the class password as a temporary one:
      // the student has to choose their own before they get any token.
      return { status: 'new-password-required', session: auth.Session, username };
    }
    if (!auth.AuthenticationResult) {
      throw new Error('Unexpected challenge: ' + (auth.ChallengeName || 'unknown'));
    }
    await finish(username, auth.AuthenticationResult);
    rememberLogin(username, password);
    return { status: 'ok' };
  }

  // First login creates the account. The pool is open, but the PreSignUp
  // trigger (admin/presignup/) only lets the account through when the
  // password IS the shared class password (sent again as classKey), and then
  // auto-confirms it. So every student has the same password, and nobody
  // without it can create anything. Resolves { status: 'ok' } once logged in.
  async function signUp(username, password) {
    await cognito(IDP_HOST, 'AWSCognitoIdentityProviderService.SignUp', {
      ClientId: CLIENT_ID,
      Username: username,
      Password: password,
      ClientMetadata: { classKey: password }
    });
    return login(username, password);
  }

  // Answer the NEW_PASSWORD_REQUIRED challenge
  async function setNewPassword(username, challengeSession, newPassword) {
    const auth = await cognito(IDP_HOST, 'AWSCognitoIdentityProviderService.RespondToAuthChallenge', {
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: challengeSession,
      ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword }
    });
    if (!auth.AuthenticationResult) throw new Error('Could not set the new password.');
    await finish(username, auth.AuthenticationResult);
    rememberLogin(username, newPassword);
    return { status: 'ok' };
  }

  async function finish(username, result) {
    session = { username, refreshToken: result.RefreshToken };
    saveSession();
    await exchangeForCredentials(result.IdToken);
  }

  // Silently re-authenticate with the stored refresh token
  async function refresh() {
    if (!session || !session.refreshToken) throw new Error('Not logged in.');
    const auth = await cognito(IDP_HOST, 'AWSCognitoIdentityProviderService.InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: session.refreshToken }
    });
    if (!auth.AuthenticationResult) throw new Error('Session expired. Log in again.');
    await exchangeForCredentials(auth.AuthenticationResult.IdToken);
  }

  // Valid credentials, renewing them when they are about to expire
  async function ensureCredentials() {
    if (creds && Date.now() < creds.expiresAt) return creds;
    await refresh();
    return creds;
  }

  function dropSession() {
    session = null;
    creds = null;
    identityId = null;
    try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to do */ }
  }

  function logout() {
    dropSession();
    forgetRememberedLogin();
  }

  function isLoggedIn() { return !!(session && session.refreshToken); }
  function username() { return session ? session.username : null; }

  // ---------------------------------------------------------------- SigV4

  async function sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hmac(key, msg) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' },
                                            false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  }

  async function signingKey(secret, stamp) {
    let key = new TextEncoder().encode('AWS4' + secret);
    for (const part of [stamp, REGION, 's3', 'aws4_request']) key = await hmac(key, part);
    return key;
  }

  // RFC 3986. S3 keys contain ':' (the identity id does), which must be
  // percent-encoded identically in the canonical request and in the URL.
  function uriEncode(text, keepSlash) {
    let out = '';
    for (const ch of text) {
      if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
      else for (const byte of new TextEncoder().encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  async function s3(method, key, query, body, contentType) {
    const c = await ensureCredentials();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+/, '');
    const stamp = amzDate.slice(0, 8);
    const payload = body || '';
    const payloadHash = await sha256hex(payload);

    // The session token is part of the signature, not just a header
    const headers = {
      'host': S3_HOST,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': c.SessionToken
    };
    if (method !== 'GET') headers['content-type'] = contentType || 'application/json';

    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    const canonicalHeaders = names.map(n => n + ':' + headers[n].trim() + '\n').join('');
    const canonicalUri = '/' + uriEncode(key, true);

    const canonicalRequest = [method, canonicalUri, query || '',
                              canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = stamp + '/' + REGION + '/s3/aws4_request';
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope,
                    await sha256hex(canonicalRequest)].join('\n');
    const sigBytes = await hmac(await signingKey(c.SecretKey, stamp), toSign);
    const signature = [...sigBytes].map(b => b.toString(16).padStart(2, '0')).join('');

    const fetchHeaders = { ...headers, 'Authorization':
      'AWS4-HMAC-SHA256 Credential=' + c.AccessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature };
    delete fetchHeaders.host;   // the browser sets Host and forbids overriding it

    return fetch('https://' + S3_HOST + canonicalUri + (query ? '?' + query : ''), {
      method,
      headers: fetchHeaders,
      body: method === 'GET' ? undefined : payload
    });
  }

  // ---------------------------------------------------------------- storage

  function prefix() {
    const user = username();
    if (!user) throw new Error('Not logged in.');
    return user + '/';
  }

  async function putJson(key, value) {
    const resp = await s3('PUT', key, '', JSON.stringify(value, null, 2));
    if (!resp.ok) throw new Error('Upload failed: ' + resp.status + ' ' + await resp.text());
    return true;
  }

  async function putText(key, text, contentType) {
    const resp = await s3('PUT', key, '', text, contentType || 'text/x-python');
    if (!resp.ok) throw new Error('Upload failed: ' + resp.status + ' ' + await resp.text());
    return true;
  }

  async function getJson(key) {
    const resp = await s3('GET', key, '');
    if (resp.status === 404 || resp.status === 403) return null;
    if (!resp.ok) throw new Error('Download failed: ' + resp.status + ' ' + await resp.text());
    return resp.json();
  }

  // ------------------------------------------------ readable key helpers
  // The .py is named after the exercise file, case kept, so the bucket reads
  // like the exercise folder: "ex/python-exercice-D3-undo-history.md" gives
  // "D3-undo-history" and the object "tin-D3-undo-history-001-accepted.py".
  function slugFile(file, fallbackId) {
    const base = String(file || '').split('/').pop().replace(/\.md$/, '')
      .replace(/^python-exercices?-/, '');
    return (base || String(fallbackId || ''))
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  // "D3-undo-history" -> "D3": the part before the first dash
  function slugId(slug) { return slug.split('-')[0]; }

  // List every object under an arbitrary key prefix (newest first).
  async function listPrefix(keyPrefix) {
    const query = 'list-type=2&prefix=' + uriEncode(keyPrefix, false);
    const resp = await s3('GET', '', query);
    if (!resp.ok) throw new Error('List failed: ' + resp.status);
    const xml = new DOMParser().parseFromString(await resp.text(), 'text/xml');
    return [...xml.getElementsByTagName('Contents')].map(node => {
      const text = tag => {
        const el = node.getElementsByTagName(tag)[0];
        return el ? el.textContent : '';
      };
      return { key: text('Key'), size: Number(text('Size')), modified: text('LastModified') };
    }).sort((a, b) => (a.modified < b.modified ? 1 : -1));
  }

  // Next 3-digit sequence for this student's exercise (any status): 001, 002...
  async function nextSeq(user, slug) {
    const items = await listPrefix(prefix() + user + '-' + slug + '-');
    return String(items.length + 1).padStart(3, '0');
  }

  // The student's own answers (the *.py files), newest first.
  async function listSubmissions() {
    const items = await listPrefix(prefix());
    return items.filter(it => it.key.endsWith('.py'));
  }

  // Save one answer as its own readable object, and refresh latest.json:
  //   <user>/<user>-<file slug>-<seq>-<status>.py    (the code)
  //   <user>/latest-class-01.json                    (the full state)
  async function submit(state) {
    const user = username();
    const record = { ...state, username: user, savedAt: new Date().toISOString() };

    if (state.exercise && state.exercise !== 'all' && state.code != null && state.code !== '') {
      const slug = slugFile(state.file, state.exercise);
      const status = (state.status || 'submitted').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const seq = await nextSeq(user, slug);
      const name = [user, slug, seq, status].filter(Boolean).join('-') + '.py';
      record.file = prefix() + name;
      await putText(prefix() + name, state.code);
    }

    // A login snapshot also backfills: every exercise that passed before the
    // student had an account (or on another device) gets its accepted .py if
    // none exists yet, so the teacher's folder shows the whole trail.
    if (state.backfill && state.solved) {
      const have = await listPrefix(prefix() + user + '-');
      for (const [exId, code] of Object.entries(state.solved)) {
        const slug = slugFile((state.files || {})[exId], exId);
        if (!code || have.some(it => it.key.startsWith(prefix() + user + '-' + slugId(slug) + '-'))) continue;
        const name = [user, slug, '001', 'accepted'].join('-') + '.py';
        await putText(prefix() + name, code);
        record.backfilled = (record.backfilled || []).concat(exId);
      }
    }

    await putJson(prefix() + LATEST_KEY, record);
    return record;
  }

    async function loadLatest() { return getJson(prefix() + LATEST_KEY); }
  async function loadSubmission(key) { return getJson(key); }

  global.ClassroomSync = {
    login, signUp, setNewPassword, logout, dropSession, isLoggedIn, username,
    rememberLogin, rememberedLogin, forgetRememberedLogin,
    identity: () => identityId,
    restore: loadSession,
    ensureCredentials,
    submit, loadLatest, listSubmissions, loadSubmission,
    config: { REGION, BUCKET, USER_POOL_ID, IDENTITY_POOL_ID }
  };
})(typeof window !== 'undefined' ? window : self);
