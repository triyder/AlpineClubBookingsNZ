- **Account credit is now used in the same order every time (#4013).** When a
  member's account credit is applied to a booking, the system uses their
  oldest credit first. Two pieces of credit recorded at exactly the same moment
  could previously be used in either order, so the same booking could
  sometimes use an existing Xero credit note and sometimes create a new one.
  Credit recorded at the same moment is now always used in the same fixed
  order. No amounts change.

  One case now stops instead of guessing: when a retry of an interrupted
  allocation would no longer keep what its earlier attempt recorded (for
  example one interrupted across this upgrade, or one whose credit was partly
  handed back in between), the Xero operation fails with a message naming the
  booking, and nothing is allocated twice. If credit was handed back, retry it
  once that hand-back has gone through; if the booking's credit notes in Xero
  genuinely disagree with its allocations, resolve the operation in Xero.
