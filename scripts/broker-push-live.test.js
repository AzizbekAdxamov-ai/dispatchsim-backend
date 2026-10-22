// Manual provider run only: REPORT_PATH=<file> node --env-file=.env scripts/broker-push-live.test.js --execute
// Importing under node --test does not send requests.
import { launchLive } from './brokerLiveRunner.js'

launchLive('push', import.meta.url)
