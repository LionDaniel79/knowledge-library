# PDF progress retry

The real PC job completed its 9,321-file scan, while a delayed progress read was
shown as a failure. Keep the last known running job and its counts when a
progress read times out or encounters a temporary network/server error. Show a
brief connection notice and continue the existing non-overlapping polling.
Clear the notice on recovery; retain real authentication and job failures.

Verify transient failure then automatic preview in desktop/mobile browser tests,
and distinguish temporary errors from authentication failures in request tests.
Deploy the verified change without restarting or discarding the existing job.
