import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventStoreEntry } from './entities/event-store-entry.entity';
import { AggregateSnapshot } from './entities/aggregate-snapshot.entity';
import { EventLog } from '../indexer/event-log.entity';
import { EventStoreService } from './event-store.service';
import { EventStoreListener } from './event-store.listener';
import { EventsController } from './events.controller';
import { EventLogPartitionService } from './event-log-partition.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EventStoreEntry, AggregateSnapshot, EventLog]),
  ],
  providers: [EventStoreService, EventStoreListener, EventLogPartitionService],
  controllers: [EventsController],
  exports: [EventStoreService, EventLogPartitionService],
})
export class EventStoreModule {}
