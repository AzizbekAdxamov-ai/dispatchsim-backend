// Manual provider run only: REPORT_PATH=<file> node --env-file=.env scripts/broker-walkaway-live.test.js --execute
// Importing under node --test does not send requests.
import { launchLive } from './brokerLiveRunner.js'

launchLive('walkaway', import.meta.url)
