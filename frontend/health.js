import { registerPlugin, Capacitor } from '@capacitor/core';
export const Health=registerPlugin('ClearPathHealth');
export const nativePlatform=()=>Capacitor.isNativePlatform()?Capacitor.getPlatform():null;
