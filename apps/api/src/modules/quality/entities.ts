import { Disposal, DisposalLine, DisposalMember } from './disposal.entities';
import { QualityComplaint, QualityHold, Recall, RecallReturn, StorageUnit, TemperatureExcursion, TemperatureReading } from './quality.entities';

export const QUALITY_ENTITIES = [QualityHold, StorageUnit, TemperatureReading, TemperatureExcursion, QualityComplaint, Recall, RecallReturn, Disposal, DisposalLine, DisposalMember];
