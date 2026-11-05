// Manual provider run only: REPORT_PATH=<file> node --env-file=.env scripts/broker-chat-live.test.js --execute
// Importing under node --test does not send requests.
import { launchLive } from './brokerLiveRunner.js'

launchLive('chat', import.meta.url)
