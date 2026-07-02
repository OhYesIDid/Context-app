import Purchases, { LOG_LEVEL, type CustomerInfo, type PurchasesOfferings, type PurchasesPackage } from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
import { NativeModules } from 'react-native';

function syncProToNative(isPro: boolean) {
  NativeModules.ProTxtSettings?.setProStatus(isPro);
}

const RC_API_KEY_ANDROID = process.env.EXPO_PUBLIC_RC_API_KEY_ANDROID ?? '';

export const PRO_ENTITLEMENT = 'ConTxt Pro';

export function configurePurchases() {
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey: RC_API_KEY_ANDROID });
  } catch (e) {
    console.warn('RevenueCat configure failed:', e);
  }
}

export async function checkProEntitlement(): Promise<boolean> {
  try {
    const info = await Purchases.getCustomerInfo();
    const isPro = !!info.entitlements.active[PRO_ENTITLEMENT];
    syncProToNative(isPro);
    return isPro;
  } catch {
    return false;
  }
}

export function addEntitlementListener(cb: (isPro: boolean) => void): () => void {
  const handler = (info: CustomerInfo) => {
    const isPro = !!info.entitlements.active[PRO_ENTITLEMENT];
    syncProToNative(isPro);
    cb(isPro);
  };
  Purchases.addCustomerInfoUpdateListener(handler);
  return () => Purchases.removeCustomerInfoUpdateListener(handler);
}

export async function fetchOfferings(): Promise<PurchasesOfferings | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5_000);
    Purchases.getOfferings()
      .then((o) => { clearTimeout(timer); resolve(o); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

export async function purchasePkg(pkg: PurchasesPackage): Promise<boolean> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return !!customerInfo.entitlements.active[PRO_ENTITLEMENT];
}

export async function restorePurchases(): Promise<boolean> {
  try {
    const info = await Purchases.restorePurchases();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch {
    return false;
  }
}

// Opens RC's Customer Center so Pro users can manage or cancel their subscription.
export async function presentCustomerCenter(): Promise<void> {
  try {
    await RevenueCatUI.presentCustomerCenter();
  } catch {}
}
