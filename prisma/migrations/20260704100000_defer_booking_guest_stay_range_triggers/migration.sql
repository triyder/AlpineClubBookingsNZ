-- Defer the BookingGuest/Booking envelope triggers to commit time.
--
-- Issue #713 made a guest stay range outside the booking envelope auto-expand
-- the parent booking's checkIn/checkOut instead of being rejected. The modify
-- flows write the widened guest rows before the parent Booking row inside one
-- transaction, so the immediate row-level trigger from
-- 20260525030000_enforce_booking_guest_stay_range_envelope rejected every
-- envelope-widening edit ("BookingGuest stay range must be within parent
-- Booking date range") even though the invariant holds at commit.
--
-- The invariant is cross-table and only meaningful for committed state, so
-- both triggers become DEFERRABLE INITIALLY DEFERRED constraint triggers:
-- writes may pass through intermediate states within a transaction, and the
-- checks run against the final rows at COMMIT. The trigger functions are
-- unchanged (constraint triggers must be AFTER ROW; the functions' RETURN NEW
-- is simply ignored there).
DROP TRIGGER "BookingGuest_stay_range_within_booking" ON "BookingGuest";
CREATE CONSTRAINT TRIGGER "BookingGuest_stay_range_within_booking"
AFTER INSERT OR UPDATE OF "bookingId", "stayStart", "stayEnd"
ON "BookingGuest"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_booking_guest_stay_range_within_booking"();

DROP TRIGGER "Booking_dates_consistent_with_guests" ON "Booking";
CREATE CONSTRAINT TRIGGER "Booking_dates_consistent_with_guests"
AFTER UPDATE OF "checkIn", "checkOut"
ON "Booking"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_booking_dates_consistent_with_guests"();
