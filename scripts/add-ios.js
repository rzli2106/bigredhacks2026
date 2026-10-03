import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {configureNative} from './configure-native.js';
const require=createRequire(import.meta.url);
const cliRoot=dirname(require.resolve('@capacitor/cli/package.json'));
const {version}=require('@capacitor/cli/package.json');
if(version!=='7.6.9')throw new Error('Recheck the Capacitor SPM workaround before using a different CLI version.');
// Capacitor 7.6.9 lowercases --packagemanager before comparing it with "SPM".
// Set the same CLI configuration directly; do not patch installed packages or require CocoaPods.
const {loadConfig}=require(resolve(cliRoot,'dist/config.js'));
const {addCommand}=require(resolve(cliRoot,'dist/tasks/add.js'));
const config=await loadConfig();
config.ios.packageManager=Promise.resolve('SPM');
config.cli.assets.ios.platformTemplateArchive='ios-spm-template.tar.gz';
config.cli.assets.ios.platformTemplateArchiveAbs=resolve(cliRoot,'assets/ios-spm-template.tar.gz');
await addCommand(config,'ios');
await configureNative();
