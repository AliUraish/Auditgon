from typing import Any
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError


class ApiFailure(Exception):
    def __init__(self, status: int, message: str, code: str):
        self.status = status
        self.message = message
        self.code = code
        super().__init__(message)


def error_json(status: int, message: str, code: str) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=status,
                        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


async def api_error_handler(_request: Request, error: ApiFailure) -> JSONResponse:
    return error_json(error.status, error.message, error.code)


async def validation_error_handler(_request: Request, error: Any) -> JSONResponse:
    details = "; ".join("{}: {}".format(".".join(str(v) for v in issue["loc"]), issue["msg"]) for issue in error.errors()[:3])
    return error_json(400, "Please check the input. " + details, "INVALID_INPUT")


def register_errors(app: Any) -> None:
    app.add_exception_handler(ApiFailure, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(ValidationError, validation_error_handler)

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, _error: Exception) -> JSONResponse:
        # Never reflect provider bodies, credential values, SQL, or tracebacks.
        return error_json(500, "The inspection could not be saved. Please retry.", "INTERNAL_ERROR")
