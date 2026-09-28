/**
 * HTML the framework may write without escaping it — rfcs/0001 §19.5.
 *
 * `ctx.html()` takes one of these and nothing else. Two functions make one:
 *
 *   - `html`, the tagged template, which escapes every interpolation for the
 *     place it sits in and refuses to put one where escaping cannot help —
 *     inside a `<script>`, in an `onclick`, in an unquoted attribute;
 *   - `unsafeHtml`, the explicit statement that a string is already safe
 *     markup — a template engine's output, a page rendered at boot — spelled so
 *     that it reads as a decision in a code review, which is where §19.2 says
 *     a relaxed default belongs.
 *
 * Nominal on purpose. The brand is a `unique symbol` nothing outside core can
 * produce, so `ctx.html('<p>' + name)` is a type error rather than a script
 * tag, and an object literal cannot forge one. The runtime makes the same
 * check again against a private field, for callers without types.
 */
export interface SafeHtml {
  /** Never present at runtime — the type-level half of the brand. */
  readonly __safeHtml: unique symbol
  /** The markup, exactly as it will be written. */
  toString(): string
}
