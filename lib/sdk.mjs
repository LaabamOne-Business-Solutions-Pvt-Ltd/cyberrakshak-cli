// The monitoring libraries `cyberrakshak init` sets up, how each is installed, and how each starts.
//
// Every library is installed from its registry (all published 2026-11-21, each checked byte for byte against the
// console's /sdk/ files): npm (@cyberrakshak/monitor, @cyberrakshak/react-native), PyPI (cyberrakshak-monitor),
// Packagist (cyberrakshak/monitor), JitPack (Android) and Swift Package Manager (iOS). The install lines are the
// packages' own READMEs'. When a package manager is not there or fails, the file is downloaded from the console's
// /sdk/ instead and checked against the SHA-256 in /sdk/index.json before it is written; the shell library has no
// registry and is always downloaded. `published: false` on one sends it straight to the download (should a package
// ever be withdrawn); `--from download` or `--from registry` chooses for one run. (Each install command is fixed words
// with no ^ < > & |: on Windows a package manager is a .cmd file, which only cmd.exe runs.)

export const LIBRARIES = {
  node: {
    label: 'Node.js',
    registry: { published: true, tool: 'npm', name: '@cyberrakshak/monitor', install: ['npm', 'install', '@cyberrakshak/monitor'] },
    keyVar: 'CR_MONITOR_KEY',
  },
  'react-native': {
    label: 'React Native / Expo',
    registry: { published: true, tool: 'npm', name: '@cyberrakshak/react-native', install: ['npm', 'install', '@cyberrakshak/react-native'] },
    keyVar: 'EXPO_PUBLIC_CR_MONITOR_KEY',
    mobile: true,
  },
  php: {
    label: 'PHP',
    registry: { published: true, tool: 'composer', name: 'cyberrakshak/monitor', install: ['composer', 'require', 'cyberrakshak/monitor'] },
    keyVar: 'CR_MONITOR_KEY',
  },
  python: {
    label: 'Python',
    // pip records nothing in the project: the note says to add it to requirements.txt or pyproject.toml.
    registry: { published: true, tool: 'pip', name: 'cyberrakshak-monitor', install: ['pip', 'install', 'cyberrakshak-monitor'], record: 'Add cyberrakshak-monitor to your requirements.txt or pyproject.toml.' },
    keyVar: 'CR_MONITOR_KEY',
  },
  shell: {
    label: 'Shell and cron',
    // Only ever a file: there is no registry for a shell script.
    registry: null,
    keyVar: 'CR_MONITOR_KEY',
  },
  android: {
    label: 'Android (Kotlin)',
    // JitPack. Gradle files are the app's own: the lines are printed, not written.
    registry: {
      published: true,
      tool: 'gradle',
      name: 'com.github.LaabamOne-Business-Solutions-Pvt-Ltd:cyberrakshak-monitor-android:1.0.0',
      lines: [
        '// settings.gradle.kts, in dependencyResolutionManagement { repositories { … } }:',
        'maven("https://jitpack.io")',
        '',
        "// your app's build.gradle.kts, in dependencies { … }:",
        'implementation("com.github.LaabamOne-Business-Solutions-Pvt-Ltd:cyberrakshak-monitor-android:1.0.0")',
      ],
    },
    mobile: true,
  },
  ios: {
    label: 'iOS (Swift)',
    // Swift Package Manager. Xcode adds a package itself: the lines are printed, not written.
    registry: {
      published: true,
      tool: 'swiftpm',
      name: 'https://github.com/LaabamOne-Business-Solutions-Pvt-Ltd/cyberrakshak-monitor-swift',
      lines: [
        '// Xcode: File → Add Package Dependencies…, then',
        '//   https://github.com/LaabamOne-Business-Solutions-Pvt-Ltd/cyberrakshak-monitor-swift (from 1.0.0)',
        '// or in Package.swift:',
        '.package(url: "https://github.com/LaabamOne-Business-Solutions-Pvt-Ltd/cyberrakshak-monitor-swift", from: "1.0.0"),',
        '// and in your target: .product(name: "CyberRakshakMonitor", package: "cyberrakshak-monitor-swift")',
      ],
    },
    mobile: true,
  },
};

export const TYPES = Object.keys(LIBRARIES);

/**
 * How it starts, from each library's README; `fromRegistry` when it came from a registry (the import is the package's).
 * `flavour` for Node: 'esm' or 'cjs', from the project's package.json.
 */
export function snippet(type, { fromRegistry = false, flavour = 'esm', expo = false } = {}) {
  switch (type) {
    case 'node':
      if (flavour === 'cjs') {
        return [
          `const monitor = require('${fromRegistry ? '@cyberrakshak/monitor' : './cyberrakshak-monitor.cjs'}');`,
          "monitor.init({ key: process.env.CR_MONITOR_KEY, release: '1.0.0', environment: 'production' });",
          'app.use(monitor.expressErrorHandler()); // with Express: after your routes',
        ];
      }
      return [
        `import * as monitor from '${fromRegistry ? '@cyberrakshak/monitor' : './cyberrakshak-monitor.mjs'}';`,
        "monitor.init({ key: process.env.CR_MONITOR_KEY, release: '1.0.0', environment: 'production' });",
        'app.use(monitor.expressErrorHandler()); // with Express: after your routes',
      ];
    case 'react-native':
      return [
        `import * as monitor from '${fromRegistry ? '@cyberrakshak/react-native' : './cyberrakshak-monitor'}';`,
        `monitor.init({ key: ${expo ? 'process.env.EXPO_PUBLIC_CR_MONITOR_KEY' : "'crk_…'"}, release: '1.0.0', environment: 'production' });`,
        "monitor.setRoute('Checkout'); // the screen now shown",
      ];
    case 'php':
      return [
        ...(fromRegistry ? [] : ["require_once __DIR__.'/CyberRakshakMonitor.php';"]),
        "\\CyberRakshak\\Monitor::init(['key' => getenv('CR_MONITOR_KEY'), 'release' => '1.0.0', 'environment' => 'production']);",
      ];
    case 'python':
      return [
        'import os',
        'import cyberrakshak_monitor as monitor',
        'monitor.init(key=os.environ["CR_MONITOR_KEY"], release="1.0.0", environment="production")',
      ];
    case 'shell':
      return [
        '# CR_MONITOR_KEY from your environment (or: set -a; . ./.env; set +a)',
        './cr-report.sh run -- ./backup.sh     # runs it; if it fails, reports it',
        './cr-report.sh message "Nightly import skipped 3 rows"',
        '# or, with this command line: cyberrakshak run -- ./backup.sh',
      ];
    case 'android':
      return [
        'import ai.cyberrakshak.monitor.CyberRakshakMonitor',
        '// In your Application class, onCreate()',
        'CyberRakshakMonitor.init(this, CyberRakshakMonitor.Options(key = "crk_…", release = BuildConfig.VERSION_NAME, environment = "production"))',
        'CyberRakshakMonitor.setRoute("Checkout") // the screen now shown',
      ];
    case 'ios':
      return [
        'import CyberRakshakMonitor',
        '// In your App or AppDelegate, at launch',
        'CyberRakshakMonitor.start(.init(key: "crk_…", release: "1.0.0", environment: "production"))',
        'CyberRakshakMonitor.setRoute("Checkout") // the screen now shown',
      ];
    default:
      return [];
  }
}

/** Which of index.json's files a project of this type gets (by platform, and for Node by module flavour). */
export function wantedFiles(index, type, { flavour = 'esm' } = {}) {
  const files = (index && Array.isArray(index.files) ? index.files : []).filter((f) => f.platform === type);
  if (type === 'node') return files.filter((f) => (flavour === 'cjs' ? /\.cjs$/ : /\.mjs$/).test(f.save_as));
  return files;
}
