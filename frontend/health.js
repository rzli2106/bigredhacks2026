import { registerPlugin, Capacitor } from '@capacitor/core';
export const Health=registerPlugin('PathPulseHealth');
export const nativePlatform=()=>Capacitor.isNativePlatform()?Capacitor.getPlatform():null;
