// Host half of the desktop product plugins: registers the durable
// `compaction` settings namespace backing the composer tool-row threshold
// control (client half) and the compaction-basic backend's per-measurement
// override. The namespace is intentionally registered WITHOUT a default: an
// absent section means "not configured", so the backend keeps its composition
// config until the user picks a threshold.
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** The durable compaction settings namespace (plain string: settingsNamespace is a brand-only passthrough). */
export const COMPACTION_SETTINGS_NAMESPACE = settingsNamespace('compaction')

/** Valid user range: 10%..90% of the context window. */
export const COMPACTION_THRESHOLD_MIN = 0.1
export const COMPACTION_THRESHOLD_MAX = 0.9

/** Host registration for the compaction threshold preference. */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(COMPACTION_SETTINGS_NAMESPACE, z.object({
      thresholdRatio: z.number(),
    }), {
      validate(value) {
        const ratio = value.thresholdRatio
        // The section starts empty ("not configured"); only a SET value must
        // fall inside the user range.
        if (ratio === undefined) return
        if (typeof ratio !== 'number' || ratio < COMPACTION_THRESHOLD_MIN || ratio > COMPACTION_THRESHOLD_MAX) {
          throw new Error(`compaction thresholdRatio must be ${String(COMPACTION_THRESHOLD_MIN)}..${String(COMPACTION_THRESHOLD_MAX)}, got ${String(ratio)}`)
        }
      },
    })
  })
}
