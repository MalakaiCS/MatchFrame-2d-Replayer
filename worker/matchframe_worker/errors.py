"""Failure classification. Permanent failures are never retried."""


class JobError(Exception):
    code = "INTERNAL"
    permanent = False

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class PermanentError(JobError):
    permanent = True


class InvalidDemo(PermanentError):
    code = "INVALID_DEMO"


class UnsupportedDemo(PermanentError):
    code = "UNSUPPORTED_FORMAT"


class UnsupportedMap(PermanentError):
    code = "UNSUPPORTED_MAP"


class DemoTooLarge(PermanentError):
    code = "TOO_LARGE"


class SourceMissing(PermanentError):
    code = "SOURCE_MISSING"


class NoPlayableRounds(PermanentError):
    code = "NO_ROUNDS"


class ParseResourceLimit(PermanentError):
    code = "PARSE_LIMIT"


class LeaseLost(JobError):
    code = "LEASE_LOST"


class TransientError(JobError):
    code = "TRANSIENT"
