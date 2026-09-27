import { EventLogPartitionService } from './event-log-partition.service';

describe('EventLogPartitionService', () => {
  const makeDataSource = (type = 'postgres') => ({
    options: { type },
    query: jest.fn(),
  });

  const setup = (type?: string) => {
    const ds = makeDataSource(type);
    const service = new EventLogPartitionService(ds as any);
    const logger = (service as any).logger;
    const spies = {
      log: jest.spyOn(logger, 'log').mockImplementation(() => {}),
      debug: jest.spyOn(logger, 'debug').mockImplementation(() => {}),
      warn: jest.spyOn(logger, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(logger, 'error').mockImplementation(() => {}),
    };
    return { ds, service, spies };
  };

  it('is a no-op on non-postgres databases', async () => {
    const { ds, service } = setup('sqlite');
    await expect(service.maintainPartitions()).resolves.toBeNull();
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('warns and skips when event_logs is not partitioned yet', async () => {
    const { ds, service, spies } = setup();
    ds.query.mockResolvedValueOnce([]);

    await expect(service.maintainPartitions()).resolves.toBeNull();
    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('not partitioned'),
      }),
    );
  });

  it('calls event_logs_maintain_partitions and reports the result', async () => {
    const { ds, service, spies } = setup();
    ds.query
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ created: 2 }])
      .mockResolvedValueOnce([{ partitions: 12, defaultRows: 0 }]);

    const result = await service.maintainPartitions(5_123_456);

    expect(result).toEqual({
      created: 2,
      partitions: 12,
      defaultPartitionRows: 0,
    });
    expect(ds.query).toHaveBeenNthCalledWith(
      2,
      'SELECT event_logs_maintain_partitions($1, $2) AS created',
      [2, 5_123_456],
    );
    expect(spies.log).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'event_logs partition maintenance complete',
        created: 2,
        partitionSize: 100_000,
      }),
    );
  });

  it('logs at debug when nothing was created and warns on stranded default rows', async () => {
    const { ds, service, spies } = setup();
    ds.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ created: 0 }])
      .mockResolvedValueOnce([{ partitions: 4, defaultRows: 3 }]);

    await service.maintainPartitions();

    expect(ds.query).toHaveBeenNthCalledWith(2, expect.any(String), [2, null]);
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.debug).toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPartitionRows: 3 }),
    );
  });

  it('never throws when maintenance fails', async () => {
    const { ds, service, spies } = setup();
    ds.query.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.maintainPartitions()).resolves.toBeNull();
    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'connection refused' }),
    );
  });

  it('skips overlapping runs', async () => {
    const { ds, service } = setup();
    let release!: () => void;
    ds.query.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );

    const first = service.maintainPartitions();
    await expect(service.maintainPartitions()).resolves.toBeNull();
    release();
    await first;
    expect(ds.query).toHaveBeenCalledTimes(1);
  });

  it('runs on bootstrap and on the cron tick', async () => {
    const { service } = setup();
    const spy = jest
      .spyOn(service, 'maintainPartitions')
      .mockResolvedValue(null);
    await service.onApplicationBootstrap();
    await service.scheduledMaintenance();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
