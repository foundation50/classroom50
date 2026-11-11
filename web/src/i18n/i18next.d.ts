import "i18next"

// i18next 27 defaults `strictInterpolationChecks` to true, which only pays off
// with typed resource keys: it drops the plain `(key, options?)` overload from
// `TFunction`, so `t` stops satisfying this app's `TranslateFn`-style callbacks.
// Keys here are untyped strings, so the check has nothing to verify. Keep the
// v26 shape.
declare module "i18next" {
  interface CustomTypeOptions {
    strictInterpolationChecks: false
  }
}
