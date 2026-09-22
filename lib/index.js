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
export const UiPolishSchema = z.object(
  Object.fromEntries(FIX_IDS.map((id) => [id, z.boolean().default(true)])),
)

/**
 * Host plugin body: register the durable namespace when the optional settings
 * provider is composed. Without one the browser half falls back to the schema's
 * defaults, so the fixes still install.
 *
 * A settings service without `register` is a dsh whose settings model moved —
 * 0.1.7-alpha.1 projects Loader entries instead of registered namespaces — and it
 * is named as such here, because the alternative is an opaque TypeError in the
 * log next to a boot audit that says nothing about a settings API change.
 *
 * @param ctx - host context that may acquire the settings service.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    if (typeof settingsCtx.settings.register !== 'function') {
      settingsCtx.logger.error(
        `dsh-ui-polish: this dsh has no settings.register() (0.1.7-alpha.1 replaced the settings ` +
          `API), so the durable "${POLISH_NAMESPACE}" section is not registered and the switches ` +
          'cannot be saved. Pin dsh to 0.1.5-rc.x (latest/next), or upgrade @citisen/dsh-ui-polish.',
      )
      return
    }
    settingsCtx.settings.register(POLISH_NAMESPACE, UiPolishSchema)
  })
}
