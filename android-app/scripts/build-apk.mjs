import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT_DIR, 'android');

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const portableJdk = path.join(localAppData, 'AndroidBuildTools', 'jdk-21');
    if (fs.existsSync(portableJdk)) {
      return portableJdk;
    }
  }
  return null;
}

function resolveAndroidSdk() {
  for (const candidate of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultSdk = path.join(localAppData, 'Android', 'Sdk');
    if (fs.existsSync(defaultSdk)) {
      return defaultSdk;
    }
  }
  return null;
}

function runCommand(command, args, cwd, env) {
  const isWin = process.platform === 'win32';
  if (isWin && (command.endsWith('.cmd') || command.endsWith('.bat') || command === 'npm' || command === 'npx')) {
    const resolvedCommand = command === 'npm' || command === 'npx' ? `${command}.cmd` : command;
    const cmdName = path.isAbsolute(resolvedCommand) ? `"${resolvedCommand}"` : resolvedCommand;
    execFileSync('cmd.exe', ['/d', '/s', '/c', `${cmdName} ${args.join(' ')}`], {
      cwd,
      env,
      stdio: 'inherit',
    });
    return;
  }

  execFileSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
}

function main() {
  const env = { ...process.env };
  const javaHome = resolveJavaHome();
  const androidSdk = resolveAndroidSdk();

  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH ?? ''}`;
  }
  if (androidSdk) {
    env.ANDROID_HOME = androidSdk;
    env.ANDROID_SDK_ROOT = androidSdk;
    const platformTools = path.join(androidSdk, 'platform-tools');
    if (fs.existsSync(platformTools)) {
      env.PATH = `${platformTools}${path.delimiter}${env.PATH ?? ''}`;
    }
    const localPropsPath = path.join(ANDROID_DIR, 'local.properties');
    const escapedSdkDir = androidSdk.replace(/\\/g, '/');
    fs.writeFileSync(localPropsPath, `sdk.dir=${escapedSdkDir}\n`, 'utf8');
  }

  console.log('1/4 Building web bundle...');
  runCommand('npm', ['run', 'build'], ROOT_DIR, env);

  console.log('2/4 Generating Android launcher icons...');
  runCommand('node', ['scripts/generate-android-icons.mjs'], ROOT_DIR, env);

  console.log('3/4 Syncing Capacitor Android project...');
  runCommand('npx', ['cap', 'sync', 'android'], ROOT_DIR, env);

  console.log('4/4 Compiling Android APK via Gradle...');
  const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  runCommand(gradleCmd, ['assembleDebug'], ANDROID_DIR, env);

  const builtApk = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(builtApk)) {
    throw new Error(`APK not found at expected path: ${builtApk}`);
  }

  const outApk = path.join(ROOT_DIR, '噪音記錄器.apk');
  fs.copyFileSync(builtApk, outApk);
  const sizeMb = (fs.statSync(outApk).size / (1024 * 1024)).toFixed(2);
  console.log(`APK ready: ${outApk} (${sizeMb} MB)`);
}

main();
