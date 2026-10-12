const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const TOOLS_DIR = path.join(__dirname, 'tools');

function tryExtract(desc, cmd, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  console.log('\n--- ' + desc + ' ---');
  console.log('CMD:', cmd);
  try {
    execSync(cmd, { stdio: 'pipe' });
    const items = fs.existsSync(destDir) ? fs.readdirSync(destDir) : ['<no dir>'];
    console.log('exit 0, contents:', items.length ? items.slice(0, 5) : '<EMPTY>');
  } catch (e) {
    console.log('ERR:', (e.stderr || '').toString().split('\n')[0]);
  }
}

const zip = path.join(TOOLS_DIR, 'ffmpeg.zip');
const destA = path.join(TOOLS_DIR, 'extA');
const destB = path.join(TOOLS_DIR, 'extB');
const destC = path.join(TOOLS_DIR, 'extC');
const destD = path.join(TOOLS_DIR, 'extD');
const destE = path.join(TOOLS_DIR, 'extE');

tryExtract('backslash', `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip}' -DestinationPath '${destA}'"`, destA);
tryExtract('forward', `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip.replace(/\\/g, '/')}' -DestinationPath '${destB.replace(/\\/g, '/')}'"`, destB);
tryExtract('backslash no-force', `powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${destC}'"`, destC);
tryExtract('cmdlet direct', `powershell -NoProfile -Command "& { Expand-Archive -Path '${zip}' -DestinationPath '${destD}' }"`, destD);
tryExtract('tar.exe', `tar -xf "${zip}" -C "${destE}"`, destE);