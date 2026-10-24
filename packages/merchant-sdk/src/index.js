export * from './client.js';
import './youpi-checkout.js';

const scope = typeof window !== 'undefined' ? window : globalThis;
export const YoupiCheckout = scope.YoupiCheckout;
export const Youpi = scope.Youpi;
export const Razorpay = scope.Razorpay;
export default YoupiCheckout;

