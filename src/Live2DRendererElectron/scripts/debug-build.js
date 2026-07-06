const builder = require('electron-builder');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const configPath = path.join(projectDir, 'electron-builder.yml');
console.log('Project dir:', projectDir);
console.log('Config path:', configPath);
console.log('CWD:', process.cwd());
console.log('Node version:', process.version);

async function main() {
  try {
    const result = await builder.build({
      projectDir: projectDir,
      config: configPath,
      dir: true,
    });
    console.log('Build result:', JSON.stringify(result, null, 2));
    console.log('SUCCESS!');
  } catch (err) {
    console.error('BUILD FAILED:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

main();
