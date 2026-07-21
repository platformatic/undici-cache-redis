import fs from 'node:fs'
import path from 'node:path'

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json')
let { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

let passedVersion = process.argv[2]

const semverRegex = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/

if (passedVersion) {
  passedVersion = passedVersion.trim().replace(/^v/, '')
  if (!semverRegex.test(passedVersion)) {
    throw new Error(`Invalid semver version: ${passedVersion}`)
  }
  if (version !== passedVersion) {
    console.log(`Syncing version from ${version} to ${passedVersion}`)
    version = passedVersion
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    packageJson.version = version
    fs.writeFileSync(path.resolve('./package.json'), JSON.stringify(packageJson, null, 2) + '\n', { encoding: 'utf-8' })
  }
} else {
  throw new Error('Version argument is required')
}
