import { createApp } from '~/app'
import { createContainer } from '~/container'
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
    // process ends, however shutdown ended.
    exit: (code) => {
      container.close().then(
        () => process.exit(code),
        () => process.exit(1)
      )
    },
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
