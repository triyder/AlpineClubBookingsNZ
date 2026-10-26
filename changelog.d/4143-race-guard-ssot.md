- **Test harness: one database-name guard for every real-database race suite
  (#4142).** One suite kept its own copy of the guard with a different database-name
  rule, and refused a throwaway database that every other suite accepts. Developer tooling only.
