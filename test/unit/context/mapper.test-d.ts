import { expectTypeOf } from "vitest";
import type {
  DegradedReason,
  MappingFailure,
  MappingFailureCode,
  MappingResult,
} from "../../../src/context/mapper.js";

expectTypeOf<MappingFailure["code"]>().toEqualTypeOf<MappingFailureCode>();
expectTypeOf<MappingResult["degradedReasons"]>().toEqualTypeOf<DegradedReason[]>();
