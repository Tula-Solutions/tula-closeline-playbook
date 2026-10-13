import { createApp } from '~/app'
import { createContainer, reportSafely } from '~/container'
import { exitAfterClose, installCrashHandlers } from '~/exit'
import { serveOptions } from '~/http/serve'
import { shutdown, stoppableWith } from '~/shutdown'

const container = createContainer()
const app = createApp(container)
const server = Bun.serve(serveOptions(container, app))
container.consumer.start()

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

function stop(signal: string): void {
  void shutdown({
    signal,
    // Stopping the consumer ends receiving and finishes or releases what is in flight.
    server: stoppableWith(server, container.consumer, container.env.CONSUMER_STOP_DEADLINE_MS),
    lifecycle: container.lifecycle,
    clock: container.clock,
    logger: container.logger,
    graceMs: container.env.SHUTDOWN_GRACE_MS,
    timeoutMs: container.env.SHUTDOWN_TIMEOUT_MS,
    // Pending error reports are delivered and the database connections released before the
    // process ends; a forced stop gives that only a short deadline.
    exit: (code) => exitAfterClose({ code, close: container.close, exit: (c) => process.exit(c) }),
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

installCrashHandlers({
  target: process,
  report: (error, context) => reportSafely(container, error, context),
  close: container.close,
  exit: (code) => process.exit(code),
})
