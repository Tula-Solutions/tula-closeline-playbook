/**
 * The Admin switch's two statements. They live here, not in the db library, which exports only the
 * column (`playbook.index_settings.learn_from_agent_moments`, default true; a missing row means on).
 */

/** The switch of an Organization: no row means the default, on. `$1` the Organization. */
export const LEARNING_GET = `select learn_from_agent_moments
from playbook.index_settings
where organization_id = $1`

/**
 * Sets the switch, creating the Organization's settings row when it has none (with the embedder's
 * model and dimension, which the first indexing may still change while no vector is written).
 * `$1` Organization, `$2` model, `$3` dimension, `$4` the switch. Idempotent: the end state is the answer.
 */
export const LEARNING_SET = `insert into playbook.index_settings
  (organization_id, embedding_model, embedding_dimension, learn_from_agent_moments)
values ($1, $2, $3::int, $4::boolean)
on conflict (organization_id) do update set
  learn_from_agent_moments = excluded.learn_from_agent_moments, updated_at = clock_timestamp()
returning learn_from_agent_moments`
