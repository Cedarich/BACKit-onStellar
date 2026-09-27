import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexerService } from './indexer.service';
import { IndexerController } from './indexer.controller';
import { EventLog } from './event-log.entity';
import { EventParser } from './event-parser';
import { PlatformSettings } from './entities/platform-settings.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformConfigModule } from '../config/config.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { DiagnosticParserService } from './diagnostic-parser.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EventLog, PlatformSettings, FailedTransaction]),
    ScheduleModule.forRoot(),
    PlatformConfigModule,
    NotificationsModule,
    PayoutsModule,
    TreasuryModule,
  ],
  controllers: [IndexerController],
  providers: [
    IndexerService,
    EventParser,
    PlatformSettingsService,
    DiagnosticParserService,
    {
      provide: SorobanRpc.Server,
      useFactory: () => {
        return new SorobanRpc.Server(
          process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
        );
      },
    },
  ],
  exports: [IndexerService, DiagnosticParserService],
})
export class IndexerModule {}
