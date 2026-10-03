import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureNative} from '../scripts/configure-native.js';
test('native configuration inserts privacy keys at the plist root and is idempotent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pathpulse-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'ios/App/App'),{recursive:true});await mkdir(join(root,'android'),{recursive:true});
 await writeFile(join(root,'ios/App/App/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>Nested</key><dict><key>Enabled</key><true/></dict></dict></plist>');
 await writeFile(join(root,'ios/App/App/AppDelegate.swift'),'import Capacitor\nfunc application() -> Bool { return true }');await writeFile(join(root,'android/variables.gradle'),'ext { minSdkVersion = 23 }');
 assert.deepEqual(await configureNative(root),{ios:true,android:true});await configureNative(root);
 const plist=await readFile(join(root,'ios/App/App/Info.plist'),'utf8');assert.ok(plist.indexOf('NSHealthShareUsageDescription')>plist.indexOf('</dict>'));assert.equal(plist.split('NSHealthShareUsageDescription').length-1,1);
 const delegate=await readFile(join(root,'ios/App/App/AppDelegate.swift'),'utf8');assert.equal(delegate.split('restoreObservers()').length-1,1);assert.ok((await readFile(join(root,'android/variables.gradle'),'utf8')).includes('minSdkVersion = 34'));
 assert.ok((await readFile(join(root,'ios/App/App/PathPulse.entitlements'),'utf8')).includes('com.apple.developer.healthkit.background-delivery'));
});
