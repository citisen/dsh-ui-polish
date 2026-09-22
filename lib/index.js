/**
 * Host half of `dsh-ui-polish`.
 *
 * A dsh Web profile bundle has two halves. This file is the Node half: it owns
 * the durable `ui-polish` settings namespace, so which fixes are enabled
 * survives a restart inside `$DSH_HOME/settings.yaml`. It paints nothing — every
 * fix in this package acts on the browser's own event handling — so there is no
 * pre-paint row and no webserver injection here.
 *
 * The browser half lives in `./client` (`src/client.js` -> `lib/client.js`) and
 * owns the fixes themselves and the Settings row that switches them.
 *
 * @module dsh-ui-polish
 */

import z from '@deepseek-ai/schemastery'

/**
 * Settings namespace owned by this plugin. Lowercase-hyphenated, matching the
 * sibling namespaces the Web surface already ships (`ui-theme`, `ui-font`).
 */
export const POLISH_NAMESPACE = 'ui-polish'

/**
 * Every fix this package carries, in the order the settings row lists them.
 *
 * Each id is both the fix's identity in the browser half and its settings key,
 * so the two halves have to agree on this list and nothing else. They cannot
 * import it from a shared module — separate bundles, separate graphs — so it is
 * duplicated by hand and `scripts/verify-client.mjs` compares the two copies,
 * which turns a silent drift into a failing check.
 *
 * Naming: a fix is named for the behaviour the user gets, not for the component
 * it patches, because the id is the word a bug report will use.
 */
export const FIX_IDS = ['wheelThroughWidthHandle']

/**
 * Durable switch state: one boolean per fix.
 *
 * Every fix defaults to on. A fix exists because the shipped behaviour is
 * wrong, so making the user opt in to a correction would mean shipping the bug
 * and hiding the cure; the switch is there to get out of the way when a fix
 * misfires, not to advertise the package.
 */
const fixField = () => z.boolean().default(true)

export const UiPolishSchema = z.object(
  Object.fromEntries(FIX_IDS.map((id) => [id, fixField()])),
)

/**
 * Mark one field as editable configuration, on whichever schema library the
 * profile resolves.
 *
 * The 0.1.7 configuration model exposes only fields marked volatile, and the copy
 * of `@deepseek-ai/schemastery` a profile hoists may predate `.volatile()`: the
 * 0.1.5-rc.x line ships 3.18.2, where the method does not exist, and 0.1.7 ships
 * 3.18.3, where it does. That hoisted copy is what this module's own import
 * resolves, so calling `.volatile()` is both a TypeError risk on one line and — if
 * guarded away, as it first was — a silent way to leave every field unmarked. An
 * unmarked field is invisible to the configuration editor, and dsh's own import of
 * a legacy `settings.yaml` section into this entry is refused because the entry
 * then has no volatile fields at all.
 *
 * `extra('volatile', true)` is the primitive both versions have — 3.18.3's
 * `.volatile()` is exactly that call — so volatility is set through it, with the
 * public method kept as a fallback for a library that drops the primitive.
 *
 * @param schema - the field schema.
 * @returns the field, marked volatile.
 */
const editableField = (schema) => {
  if (typeof schema.extra === 'function') return schema.extra('volatile', true)
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema
}

/**
 * The same switches as a dsh 0.1.7+ configuration form.
 *
 * That line keys settings by Loader entry id — this bundle's patch inserts the
 * entry as `ui-polish`, so the namespace is the same string both lines use — and
 * exposes only the fields marked `.volatile()` to the configuration editor. The
 * entry's Config is the durable section there, which is why this is exported
 * rather than registered.
 */
export const Config = z.object(
  Object.fromEntries(FIX_IDS.map((id) => [id, editableField(fixField())])),
)

/**
 * Host plugin body: make the durable section real on whichever settings line is
 * composed. Without one the browser half falls back to the schema's defaults, so
 * the fixes still install.
 *
 * The two lines are named explicitly rather than probed for a version: the
 * 0.1.5-rc.x service exposes `register(namespace, schema)`, and the 0.1.7+
 * service carries the entry's own `Config` instead — this package ships its own
 * Settings row, so the generated page is turned off there. A service with
 * neither is reported, because the alternative is an opaque TypeError in the log
 * next to a boot audit that says nothing about a settings API change.
 *
 * @param ctx - host context that may acquire the settings service.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (typeof settings.register === 'function') {
      settings.register(POLISH_NAMESPACE, UiPolishSchema)
      return
    }
    if (typeof settings.configure === 'function') {
      settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber))
      return
    }
    settingsCtx.logger.error(
      `dsh-ui-polish: this dsh exposes neither settings.register() nor settings.configure(), so ` +
        `the durable "${POLISH_NAMESPACE}" section has nowhere to live and the switches cannot be ` +
        'saved. Pin dsh to 0.1.5-rc.x (latest/next), or upgrade @citisen/dsh-ui-polish.',
    )
  })
}
