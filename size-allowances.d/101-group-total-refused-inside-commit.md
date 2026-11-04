# File-size allowance for refusing the locked group total inside the commit (#101 follow-up, upstream #4715)

file: src/lib/group-settlement.ts
lines: 1680
reason: the post-lock below-minimum refusal moves into
  `commitChildrenToConfirmed`'s transaction, so a refusal rolls back every
  child it confirmed. The commit's card intent now carries the club format,
  which the refusal needs. Splitting this 1,600-line module is its own piece of
  work.
