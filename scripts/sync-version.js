// .github/VERSION is the only place a release version is edited. This copies
// it into package.json and package-lock.json, which electron-builder (installer
// names) and app.getVersion() read. Runs before `npm run dev` and
// `npm run package`; the release workflow gets it through the latter.
//
//   node scripts/sync-version.js           write the version into the npm files
//   node scripts/sync-version.js --print   print the version and change nothing

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const versionFile = path.join(root, '.github', 'VERSION')

// MAJOR.MINOR.PATCH with an optional pre-release suffix (2.3.0-beta.1).
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function readVersion() {
  const version = fs.readFileSync(versionFile, 'utf8').replace(/\s+/g, '').replace(/^v/, '')
  if (!VERSION_RE.test(version)) {
    throw new Error(`.github/VERSION must hold a version like 2.3.0 (got '${version}')`)
  }
  return version
}

function writeVersion(file, version, apply) {
  if (!fs.existsSync(file)) return false
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  const before = JSON.stringify(json)
  apply(json, version)
  if (JSON.stringify(json) === before) return false
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  return true
}

try {
  const version = readVersion()
  if (process.argv.includes('--print')) {
    console.log(version)
  } else {
    const pkg = writeVersion(path.join(root, 'package.json'), version, (j, v) => { j.version = v })
    const lock = writeVersion(path.join(root, 'package-lock.json'), version, (j, v) => {
      j.version = v
      if (j.packages && j.packages['']) j.packages[''].version = v
    })
    if (pkg || lock) console.log(`Version set to ${version}`)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
