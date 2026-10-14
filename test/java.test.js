const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJavaSettings, pickJava } = require('../lib/java');

const settings = (spec, extra = '') => `Property settings:\n    java.specification.version = ${spec}\n    java.runtime.version = ${spec}.0.1+7\n${extra}openjdk version "${spec}"\n`;

test('parseJavaSettings handles legacy and modern version strings', () => {
    assert.equal(parseJavaSettings(settings('1.8')).major, 8);
    assert.equal(parseJavaSettings(settings('17')).major, 17);
    assert.equal(parseJavaSettings(settings('25', '    java.vendor.version = Temurin-25.0.4+7\n')).vendor, 'Temurin-25.0.4+7');
    assert.equal(parseJavaSettings('garbage'), null);
});

test('pickJava prefers the lowest suitable non-shim Temurin runtime', () => {
    const runtimes = [
        { path: 'C:\\javapath\\java.exe', major: 21, shim: true, vendor: '' },
        { path: 'C:\\Zulu\\21\\bin\\java.exe', major: 21, shim: false, vendor: 'Zulu' },
        { path: 'C:\\Eclipse Adoptium\\jdk-21\\bin\\java.exe', major: 21, shim: false, vendor: 'Temurin' },
        { path: 'C:\\Eclipse Adoptium\\jdk-25\\bin\\java.exe', major: 25, shim: false, vendor: 'Temurin' },
    ];
    assert.equal(pickJava(runtimes, 17).path, 'C:\\Eclipse Adoptium\\jdk-21\\bin\\java.exe');
    assert.equal(pickJava(runtimes, 25).major, 25);
    assert.equal(pickJava(runtimes, 26), null);
});
