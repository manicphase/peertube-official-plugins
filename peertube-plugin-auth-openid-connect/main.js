const openidModule = require('openid-client')
const crypto = require('crypto')

const store = {
  client: null,
  userAuthenticated: null,
  secretKey: null,
  redirectUrl: null
}

const encryptionOptions = {
  algorithm: 'aes256',
  inputEncoding: 'utf8',
  outputEncoding: 'hex'
}

const cookieName = 'plugin-auth-openid-code-verifier'

async function register ({
  registerExternalAuth,
  unregisterExternalAuth,
  registerSetting,
  settingsManager,
  peertubeHelpers,
  getRouter
}) {
  const { logger } = peertubeHelpers

  registerSetting({
    name: 'discover-url',
    label: 'Discover URL',
    type: 'input',
    private: true
  })

  registerSetting({
    name: 'client-id',
    label: 'Client ID',
    type: 'input',
    private: true
  })

  registerSetting({
    name: 'client-secret',
    label: 'Client secret',
    type: 'input',
    private: true
  })

  registerSetting({
    name: 'username-property',
    label: 'Username property',
    type: 'input',
    private: true,
    default: 'preferred_username'
  })

  registerSetting({
    name: 'mail-property',
    label: 'Email property',
    type: 'input',
    private: true,
    default: 'email'
  })

  registerSetting({
    name: 'display-name-property',
    label: 'Display name property',
    type: 'input',
    private: true
  })

  registerSetting({
    name: 'role-property',
    label: 'Role property',
    type: 'input',
    private: true
  })

  const router = getRouter()
  router.use('/id-token-cb', (req, res) => handleCb(peertubeHelpers, settingsManager, req, res))

  store.redirectUrl = peertubeHelpers.config.getWebserverUrl() + '/plugins/auth-openid-connect/router/id-token-cb'

  const secretKeyBuf = await getRandomBytes(16)
  store.secretKey = secretKeyBuf.toString('hex')

  await loadSettingsAndCreateClient(registerExternalAuth, unregisterExternalAuth, peertubeHelpers, settingsManager)

  settingsManager.onSettingsChange(() => {
    loadSettingsAndCreateClient(registerExternalAuth, unregisterExternalAuth, peertubeHelpers, settingsManager)
      .catch(err => logger.error('Cannot load settings and create client after settings changes.', { err }))
  })
}

async function unregister () {
  return
}

module.exports = {
  register,
  unregister
}

// ############################################################################

async function loadSettingsAndCreateClient (registerExternalAuth, unregisterExternalAuth, peertubeHelpers, settingsManager) {
  const { logger, config } = peertubeHelpers

  if (store.client) {
    unregisterExternalAuth('openid')
  }

  store.client = null
  store.userAuthenticated = null

  const settings = await settingsManager.getSettings([
    'discover-url',
    'client-id',
    'client-secret'
  ])

  if (!settings['discover-url']) {
    logger.info('Do not register external openid auth because discover URL is not set.')
    return
  }

  if (!settings['client-id']) {
    logger.info('Do not register external openid auth because client ID is not set.')
    return
  }

  const discoverUrl = settings['discover-url']
  const issuer = await openidModule.Issuer.discover(discoverUrl)

  logger.debug('Discovered issuer %s.', discoverUrl)

  const clientOptions = {
    client_id: settings['client-id'],
    redirect_uris: [ store.redirectUrl ],
    response_types: [ 'code' ]
  }

  if (settings['client-secret']) {
    clientOptions.client_secret = settings['client-secret']
  } else {
    clientOptions.token_endpoint_auth_method = 'none'
  }

  store.client = new issuer.Client(clientOptions)

  // We already registered this external auth
  if (store.userAuthenticated) return

  const webserverUrl = config.getWebserverUrl()

  const result = registerExternalAuth({
    authName: 'openid-connect',
    authDisplayName: () => 'OpenID Connect',
    onAuthRequest: async (req, res) => {
      try {
        const codeVerifier = openidModule.generators.codeVerifier()
        const codeChallenge = openidModule.generators.codeChallenge(codeVerifier)

        const redirectUrl = store.client.authorizationUrl({
          scope: 'openid email profile',
          response_mode: 'form_post',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        })

        const encryptedCodeVerifier = await encrypt(codeVerifier)
        res.cookie(cookieName, encryptedCodeVerifier, {
          secure: webserverUrl.startsWith('https://'),
          httpOnly: true,
          sameSite: 'none',
          maxAge: 1000 * 60 * 10 // 10 minutes
        })

        return res.redirect(redirectUrl)
      } catch (err) {
        logger.error('Cannot handle auth request.', { err })
      }
    }
  })

  store.userAuthenticated = result.userAuthenticated
}

async function handleCb (peertubeHelpers, settingsManager, req, res) {
  const { logger } = peertubeHelpers

  if (!store.userAuthenticated) {
    logger.info('Received callback but cannot userAuthenticated function does not exist.')
    return onCBError(res)
  }

  const encryptedCodeVerifier = req.cookies[cookieName]
  if (!encryptedCodeVerifier) {
    logger.error('Received callback but code verifier not found in request cookie.')
    return onCBError(res)
  }

  try {
    const codeVerifier = await decrypt(encryptedCodeVerifier)

    const params = store.client.callbackParams(req)
    const tokenSet = await store.client.callback(store.redirectUrl, params, { code_verifier: codeVerifier })

    const accessToken = tokenSet.access_token
    const userInfo = await store.client.userinfo(accessToken)

    const settings = await settingsManager.getSettings([
      'mail-property',
      'username-property',
      'display-name-property',
      'role-property'
    ])

    logger.debug('Got userinfo from openid auth.', { userInfo, settings })

    let role
    if (settings['role-property']) {
      role = parseInt('' + userInfo[settings['role-property']], 10)
    }

    let displayName
    if (settings['display-name-property']) {
      displayName = userInfo[settings['display-name-property']]
    }

    let username = userInfo[settings['username-property']] || ''
    username = username.replace(/[^a-z0-9._]/g, '_')

    store.userAuthenticated({
      res,
      req,
      username,
      email: userInfo[settings['mail-property']],
      displayName,
      role
    })
  } catch (err) {
    logger.error('Error in handle callback.', { err })
    onCBError(res)
  }
}

function onCBError (res) {
  res.redirect('/login?externalAuthError=true')
}

async function encrypt (data) {
  const { algorithm, inputEncoding, outputEncoding } = encryptionOptions

  const iv = await getRandomBytes(16)

  const cipher = crypto.createCipheriv(algorithm, store.secretKey, iv)
  let encrypted = cipher.update(data, inputEncoding, outputEncoding)
  encrypted += cipher.final(outputEncoding)

  return iv.toString(outputEncoding) + ':' + encrypted
}

async function decrypt (data) {
  const { algorithm, inputEncoding, outputEncoding } = encryptionOptions

  const encryptedArray = data.split(':')
  const iv = Buffer.from(encryptedArray[0], outputEncoding)
  const encrypted = Buffer.from(encryptedArray[1], outputEncoding)
  const decipher = crypto.createDecipheriv(algorithm, store.secretKey, iv)

  return decipher.update(encrypted, outputEncoding, inputEncoding) + decipher.final(inputEncoding)
}

function getRandomBytes (size) {
  return new Promise((res, rej) => {
    crypto.randomBytes(size, (err, buf) => {
      if (err) return rej(err)

      return res(buf)
    })
  })
}