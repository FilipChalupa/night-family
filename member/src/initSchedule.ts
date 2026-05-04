import { defaultScheduleYaml } from './schedule.ts'

/**
 * `npm run -w @night/member init-schedule` prints a fully commented
 * starter `schedule.yaml` to stdout. Pipe to a file:
 *
 *   npm run -w @night/member init-schedule > schedule.yaml
 *
 * Goes through stdout (rather than writing to disk) so it works the same
 * for Docker setups (where the host can capture the output) and `npm run
 * dev` (where the file naturally lands next to `.env.member`).
 */
process.stdout.write(defaultScheduleYaml())
