/**
 * Patches expo-modules-core so Node.js 22+ (which enables TypeScript stripping
 * by default but blocks it for node_modules) doesn't crash when the Expo CLI
 * loads the package. Metro still resolves the TypeScript source via the
 * "react-native" field; Node.js gets the empty-object stub via "main".
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '../node_modules/expo-modules-core/package.json');
const stubPath = path.resolve(__dirname, '../node_modules/expo-modules-core/index.js');

if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.main === 'src/index.ts') {
    pkg.main = 'index.js';
    pkg['react-native'] = 'src/index.ts';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('patched expo-modules-core/package.json');
  }
}

if (fs.existsSync(stubPath)) {
  const content = fs.readFileSync(stubPath, 'utf8');
  if (content.trim() === 'module.exports = null;') {
    fs.writeFileSync(stubPath, 'module.exports = {};\n');
    console.log('patched expo-modules-core/index.js');
  }
}
