import Purchases, { LOG_LEVEL, type CustomerInfo, type PurchasesOfferings, type PurchasesPackage } from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
import { NativeModules } from 'react-native';

function syncProToNative(isPro: boolean) {
  NativeModules.ProTxtSettings?.setProStatus(isPro);
}

// Lets the worker independently verify Pro entitlement against RevenueCat's own
// servers instead of trusting the local is_pro flag — see verifyProEntitlement in
// worker/src/index.ts. Synced once at configure time; the app_user_id is stable
// for the lifetime of the install (anonymous or identified), so no listener needed.
async function syncAppUserIdToNative() {
  try {
    const id = await Purchases.getAppUserID();
    NativeModules.ProTxtSettings?.setAppUserId(id);
  } catch {}
}

const RC_API_KEY_ANDROID = process.env.EXPO_PUBLIC_RC_API_KEY_ANDROID ?? '';

export const PRO_ENTITLEMENT = 'ConTxt Pro';

export function configurePurchases() {
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey: RC_API_KEY_ANDROID });
    syncAppUserIdToNative();
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
    const timer = setTimeout(() => { console.warn('[RC] fetchOfferings timed out after 15s'); resolve(null); }, 15_000);
    Purchases.getOfferings()
      .then((o) => {
        clearTimeout(timer);
        console.log('[RC] offerings keys:', Object.keys(o.all ?? {}));
        const pkgs = o.current?.availablePackages ?? [];
        console.log('[RC] current packages:', pkgs.map(p => p.identifier + '/' + p.product?.identifier));
        resolve(o);
      })
      .catch((e) => { clearTimeout(timer); console.warn('[RC] getOfferings error:', e?.message ?? e); resolve(null); });
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
