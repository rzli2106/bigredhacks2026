import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function configureNative(root=process.cwd()){
  const path=relative=>resolve(root,relative),result={ios:false,android:false};
  const plist=path('ios/App/App/Info.plist');
  if(await exists(plist)){
    let text=await readFile(plist,'utf8');
    for(const [key,value]of Object.entries({NSHealthShareUsageDescription:'PathPulse reads walking speed, asymmetry, step length and steps to identify fresh mobility changes. Raw health data stays on your phone.',NSMotionUsageDescription:'PathPulse uses motion to identify possible ground impacts.',NSLocationWhenInUseUsageDescription:'PathPulse matches hazards to your current Cornell location.',NSLocationAlwaysAndWhenInUseUsageDescription:'PathPulse matches hazards to your current Cornell location.'})){
      if(text.includes(`<key>${key}</key>`))continue;
      const end=text.lastIndexOf('</dict>');if(end<0)throw new Error('Info.plist has no root dictionary.');
      text=`${text.slice(0,end)}\t<key>${key}</key>\n\t<string>${value}</string>\n${text.slice(end)}`;
    }
    await writeFile(plist,text);
    await writeFile(path('ios/App/App/PathPulse.entitlements'),'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.developer.healthkit</key><true/><key>com.apple.developer.healthkit.background-delivery</key><true/></dict></plist>\n');
    const delegate=path('ios/App/App/AppDelegate.swift');let source=await readFile(delegate,'utf8');
    if(!source.includes('import PathPulseHealth'))source=source.replace('import Capacitor','import Capacitor\nimport PathPulseHealth');
    if(!source.includes('PathPulseHealthManager.shared.restoreObservers()'))source=source.replace('return true','PathPulseHealthManager.shared.restoreObservers()\n        return true');
    await writeFile(delegate,source);result.ios=true;
    const project=path('ios/App/App.xcodeproj/project.pbxproj');
    if(await exists(project)){
      let pbx=await readFile(project,'utf8');
      pbx=pbx.replace(/buildSettings = \{([\s\S]*?)\n\s*\};/g,(block,settings)=>{
        if(!/INFOPLIST_FILE\s*=\s*"?App\/Info\.plist"?;/.test(settings))return block;
        if(/CODE_SIGN_ENTITLEMENTS\s*=/.test(block))return block.replace(/CODE_SIGN_ENTITLEMENTS\s*=\s*[^;]+;/,'CODE_SIGN_ENTITLEMENTS = App/PathPulse.entitlements;');
        return block.replace('buildSettings = {','buildSettings = {\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/PathPulse.entitlements;');
      });
      await writeFile(project,pbx);
    }
  }
  const variables=path('android/variables.gradle');
  if(await exists(variables)){
    const text=await readFile(variables,'utf8');await writeFile(variables,text.replace(/minSdkVersion\s*=\s*\d+/,'minSdkVersion = 34').replace(/compileSdkVersion\s*=\s*\d+/,'compileSdkVersion = 36'));
    const gradle=path('android/build.gradle');
    if(await exists(gradle)){const build=await readFile(gradle,'utf8');await writeFile(gradle,build.replace(/com\.android\.tools\.build:gradle:[\d.]+/,'com.android.tools.build:gradle:8.10.1'));}
    result.android=true;
  }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await configureNative();
  if(result.ios)console.log('iOS privacy strings, launch hook, and signing entitlements configured. Select your signing team and enable HealthKit + Background Delivery in Xcode.');
  if(result.android)console.log('Android minimum SDK 34, compile SDK 36, and AGP 8.10.1 configured for Health Connect.');
}
