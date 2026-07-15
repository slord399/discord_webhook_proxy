#!/usr/bin/env node

// Custom zero-dependency preinstall script to enforce yarn as the package manager.
// Replaces the deprecated and heavy 'only-allow' and prevents npx/url.parse deprecation warnings.

const fs = require('fs');
const path = require('path');

const availablePMs = ['npm', 'cnpm', 'pnpm', 'yarn', 'bun'];
const wantedPM = process.argv[2] || 'yarn';

// Automatically clean up incompatible non-Yarn lockfiles to fix the "package-lock.json found" warning from baseline
const otherLockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'bun.lockb', 'shrinkwrap.yaml'];
otherLockfiles.forEach((file) => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`[preinstall] Automatically removed incompatible lockfile: ${file}`);
        } catch (e) {
            // ignore cleanup errors
        }
    }
});

if (!availablePMs.includes(wantedPM)) {
    console.error(`"${wantedPM}" is not a valid package manager. Available package managers are: ${availablePMs.join(', ')}.`);
    process.exit(1);
}

function parseUserAgent(userAgent) {
    if (!userAgent) return null;
    const pmSpec = userAgent.split(' ')[0];
    const separatorPos = pmSpec.lastIndexOf('/');
    if (separatorPos === -1) return null;
    return {
        name: pmSpec.slice(0, separatorPos),
        version: pmSpec.slice(separatorPos + 1)
    };
}

const userAgent = process.env.npm_config_user_agent;
const usedPM = parseUserAgent(userAgent);

const cwd = process.env.INIT_CWD || process.cwd();
const isInstalledAsDependency = cwd.includes('node_modules');

if (usedPM && usedPM.name !== wantedPM && !isInstalledAsDependency) {
    const width = 60;
    const borderTop = '╔' + '═'.repeat(width) + '╗';
    const borderBottom = '╚' + '═'.repeat(width) + '╝';

    const padLine = (text) => {
        const padLength = width - text.length;
        const padLeft = Math.floor(padLength / 2);
        const padRight = padLength - padLeft;
        return '║' + ' '.repeat(padLeft) + text + ' '.repeat(padRight) + '║';
    };

    console.error('\x1b[31m' + borderTop + '\x1b[0m');
    console.error('\x1b[31m║' + ' '.repeat(width) + '║\x1b[0m');
    console.error('\x1b[31m' + padLine(`Use "${wantedPM}" for installation in this project.`) + '\x1b[0m');
    console.error('\x1b[31m║' + ' '.repeat(width) + '║\x1b[0m');
    console.error('\x1b[31m' + padLine(`If you don't have Yarn, install it via "npm i -g yarn".`) + '\x1b[0m');
    console.error('\x1b[31m' + padLine('For more details, go to https://yarnpkg.com/') + '\x1b[0m');
    console.error('\x1b[31m║' + ' '.repeat(width) + '║\x1b[0m');
    console.error('\x1b[31m' + borderBottom + '\x1b[0m');

    process.exit(1);
}
