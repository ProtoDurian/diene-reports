-- branch_head.run_id   = newest finished branch run per flag that has tests or coverage
-- branch_head.cov_run_id = newest finished branch run per flag that has coverage (badge, keep/ copies, keep_blobs)
ALTER TABLE branch_head ADD COLUMN cov_run_id INTEGER;
UPDATE branch_head SET cov_run_id = run_id WHERE run_id IN (SELECT id FROM runs WHERE cov_lines IS NOT NULL);
