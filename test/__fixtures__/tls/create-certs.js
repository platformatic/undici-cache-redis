'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// Ephemeral test-only CA/server certificate. Never commit the generated key.
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', join(__dirname, 'server.key'), '-out', join(__dirname, 'server.crt'),
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
], { stdio: 'pipe' })
