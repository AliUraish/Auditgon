"""Bounded request models matching frontend/lib/contracts.ts."""
from typing import Any, Dict, List, Literal, Optional, Tuple
from urllib.parse import urlparse
from pydantic import BaseModel, ConfigDict, Field, confloat, constr, field_validator, model_validator
from .errors import ApiFailure

Identifier = constr(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
ShortIdentifier = constr(min_length=1, max_length=90, pattern=r"^[a-zA-Z0-9_-]+$")
Coordinate = confloat(strict=True, ge=-10000, le=10000, allow_inf_nan=False)
Vec3 = Tuple[Coordinate, Coordinate, Coordinate]
PixelNumber = confloat(strict=True, ge=0, le=1, allow_inf_nan=False)
Pixel = Tuple[PixelNumber, PixelNumber]
FindingStatus = Literal["open", "review", "resolved", "dismissed"]
Severity = Literal["critical", "major", "minor"]
RequiredText = constr(strip_whitespace=True, min_length=1, max_length=2000)
Finish = Literal["wood", "tile", "carpet", "concrete", "stone", "paint", "plaster", "brick", "glass", "other"]
HexColor = constr(pattern=r"^#[0-9a-fA-F]{6}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Action(StrictModel):
    action: Literal["start", "pause", "resume", "reset", "advance", "finalize", "reaudit"]
    mode: Optional[Literal["demo", "managed"]] = None


class FindingPatch(StrictModel):
    status: Optional[FindingStatus] = None
    note: Optional[constr(strip_whitespace=True, max_length=2000)] = None

    @model_validator(mode="after")
    def has_change(self):
        if self.status is None and self.note is None:
            raise ValueError("Provide a status or note.")
        return self


class ManualFinding(StrictModel):
    roomId: Identifier
    itemId: Optional[Identifier] = None
    title: constr(strip_whitespace=True, min_length=1, max_length=180)
    category: constr(strip_whitespace=True, min_length=1, max_length=80) = "Manual observation"
    severity: Severity = "minor"
    reason: RequiredText
    expected: RequiredText = "Not specified; owner observation"
    observed: RequiredText
    nextAction: RequiredText = "Review this observation and capture supporting evidence."
    anchor: Vec3
    endAnchor: Optional[Vec3] = None
    cameraPosition: Optional[Vec3] = None
    cameraTarget: Optional[Vec3] = None
    uncertainty: Optional[constr(min_length=1, max_length=300)] = None
    isSample: Optional[bool] = None
    annotationSource: Literal["scan", "reference"] = "reference"
    evidence: List[Any] = Field(default_factory=list, max_length=0)
    evidenceIds: List[Identifier] = Field(default_factory=list, max_length=8)


class Room(StrictModel):
    id: ShortIdentifier
    name: constr(strip_whitespace=True, min_length=1, max_length=100)
    level: constr(strip_whitespace=True, min_length=1, max_length=60)
    area: confloat(strict=True, ge=0, le=1_000_000, allow_inf_nan=False)
    polygon: List[Tuple[Coordinate, Coordinate]] = Field(min_length=3, max_length=128)
    center: Vec3
    adjacentRoomIds: List[Identifier] = Field(max_length=40)
    floorElevation: Optional[Coordinate] = None
    height: Optional[confloat(strict=True, gt=0, le=1000, allow_inf_nan=False)] = None
    designRoomId: Optional[ShortIdentifier] = None
    floorFinish: Optional[Finish] = None
    wallFinish: Optional[Finish] = None
    floorColor: Optional[HexColor] = None
    wallColor: Optional[HexColor] = None


class BlueprintFeature(StrictModel):
    id: ShortIdentifier
    roomId: Identifier
    kind: Literal["wall", "door", "window", "island", "stair", "ceiling", "furniture"]
    label: constr(strip_whitespace=True, min_length=1, max_length=180)
    position: Vec3
    dimensions: Optional[Vec3] = None
    expected: Optional[confloat(strict=True, ge=0, le=10000, allow_inf_nan=False)] = None
    unit: Optional[constr(max_length=20)] = None
    source: Optional[constr(max_length=400)] = None
    objectType: Optional[Literal["bed", "sofa", "table", "chair", "cabinet", "sink", "toilet", "tub", "wardrobe", "lamp", "plant", "other"]] = None
    rotation: Optional[confloat(strict=True, ge=-360, le=360, allow_inf_nan=False)] = None

    @model_validator(mode="after")
    def positive_dimensions(self):
        if self.dimensions is not None and any(value < 0 for value in self.dimensions):
            raise ValueError("Feature dimensions cannot be negative.")
        return self


class Blueprint(StrictModel):
    id: Identifier
    name: constr(strip_whitespace=True, min_length=1, max_length=180)
    revision: constr(strip_whitespace=True, min_length=1, max_length=80)
    units: Literal["m", "scene"]
    isSample: bool = False
    rooms: List[Room] = Field(min_length=1, max_length=40)
    features: List[BlueprintFeature] = Field(default_factory=list, max_length=500)
    sourceUploadId: Optional[Identifier] = None
    generatedFrom: Optional[Literal["materials", "scan"]] = None
    coordinateFrame: Optional[Literal["reference", "scan"]] = None
    metricStatus: Optional[Literal["unmeasured", "design-dimensions"]] = None

    @model_validator(mode="after")
    def references_are_valid(self):
        rooms = {room.id for room in self.rooms}
        if len(rooms) != len(self.rooms) or len({feature.id for feature in self.features}) != len(self.features):
            raise ValueError("Room and feature IDs must be unique.")
        if any(feature.roomId not in rooms for feature in self.features) or any(adjacent not in rooms for room in self.rooms for adjacent in room.adjacentRoomIds):
            raise ValueError("Every feature and connection must refer to an existing room.")
        return self


class BlueprintRequest(StrictModel):
    uploadId: Optional[Identifier] = None
    blueprint: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.uploadId) == (self.blueprint is not None):
            raise ValueError("Supply exactly one uploadId or blueprint model.")
        return self


class ScenePatch(StrictModel):
    name: Optional[constr(strip_whitespace=True, min_length=1, max_length=160)] = None
    sourceUrl: Optional[constr(max_length=2048)] = None
    assetUrl: Optional[constr(max_length=2048)] = None
    scale: Optional[confloat(strict=True, ge=0.0001, le=10000, allow_inf_nan=False)] = None
    calibrated: Optional[bool] = None


def safe_asset_url(value: Optional[str]) -> Optional[str]:
    import re
    if value is None or value == "":
        return None
    if re.fullmatch(r"/api/uploads/[a-zA-Z0-9_-]+", value):
        return value
    try:
        parsed = urlparse(value)
        invalid_port = parsed.port not in (None, 443)
    except ValueError:
        raise ApiFailure(400, "The scene URL is invalid.", "INVALID_SCENE_URL") from None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or invalid_port:
        raise ApiFailure(400, "Scene URLs must use HTTPS without credentials, or a saved scan upload.", "INVALID_SCENE_URL")
    import ipaddress
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in ("localhost", "metadata.google.internal", "metadata") or "." not in hostname or hostname.endswith((".localhost", ".local", ".internal", ".lan", ".home", ".test")):
        raise ApiFailure(400, "Scan links must refer to a public HTTPS host.", "PRIVATE_SCENE_URL")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ApiFailure(400, "Local/private scan hosts are not supported.", "PRIVATE_SCENE_URL")
    return value


class ProjectReset(StrictModel):
    action: Literal["reset"] = "reset"


class MaterialRead(StrictModel):
    uploadIds: List[Identifier] = Field(min_length=1, max_length=3)


class SpatialModelCreate(StrictModel):
    blueprint: Blueprint
    evidenceIds: List[Identifier] = Field(default_factory=list, max_length=8)
    reason: constr(strip_whitespace=True, min_length=4, max_length=2000)


class GeometryPoint(StrictModel):
    pixel: Pixel
    position: Optional[Vec3]


class Geometry(StrictModel):
    points: List[GeometryPoint] = Field(max_length=64)
    calibrated: bool
    scale: confloat(strict=True, gt=0, le=10000, allow_inf_nan=False)
    units: Literal["scene"]
    source: Literal["rendered-depth"]
    note: constr(min_length=1, max_length=2000)


class AgentToolResult(StrictModel):
    imageData: Optional[constr(max_length=2_000_000)] = None
    mimeType: Optional[Literal["image/jpeg", "image/png", "image/webp"]] = None
    cameraPosition: Optional[Vec3] = None
    cameraTarget: Optional[Vec3] = None
    geometry: Optional[Geometry] = None
    error: Optional[constr(max_length=1000)] = None


class ImageRegion(StrictModel):
    evidenceId: Identifier
    box: Tuple[PixelNumber, PixelNumber, PixelNumber, PixelNumber]
    label: Optional[constr(strip_whitespace=True, max_length=120)] = None

    @model_validator(mode="after")
    def ordered(self):
        if self.box[2] <= self.box[0] or self.box[3] <= self.box[1]:
            raise ValueError("Image box must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.")
        return self


class AgentFinding(StrictModel):
    title: constr(min_length=1, max_length=180)
    severity: Severity
    expected: RequiredText
    nextAction: RequiredText
    anchor: Optional[Vec3] = None
    endAnchor: Optional[Vec3] = None
    region: Optional[List[Vec3]] = Field(default=None, min_length=3, max_length=12)
    imageRegions: Optional[List[ImageRegion]] = Field(default=None, max_length=4)
    cameraPosition: Optional[Vec3] = None
    cameraTarget: Optional[Vec3] = None


class AgentResult(StrictModel):
    itemId: Identifier
    status: Literal["observing", "pass", "finding", "blocked"]
    basis: Optional[Literal["visual", "layout", "metric", "operation"]] = None
    observed: RequiredText
    reason: RequiredText
    evidenceIds: List[Identifier] = Field(default_factory=list, max_length=8)
    finding: Optional[AgentFinding] = None


class DiscoveredItem(StrictModel):
    roomId: Identifier
    label: constr(strip_whitespace=True, min_length=4, max_length=180)
    category: Literal["Workmanship", "Visibility"]
    reason: constr(strip_whitespace=True, min_length=4, max_length=1200)


Move = confloat(strict=True, ge=-50, le=50, allow_inf_nan=False)
Angle = confloat(strict=True, ge=-180, le=180, allow_inf_nan=False)


class AgentDeploy(StrictModel):
    role: Literal["finish-surveyor", "sketch-verifier", "measurer", "room-inspector"]
    objective: constr(strip_whitespace=True, min_length=8, max_length=1200)
    roomId: Optional[Identifier] = None
    evidenceIds: List[Identifier] = Field(default_factory=list, max_length=6)


class AgentAwait(StrictModel):
    agentIds: Optional[List[Identifier]] = Field(default=None, max_length=8)


class ViewerArgs(StrictModel):
    position: Optional[Vec3] = None
    target: Optional[Vec3] = None
    points: Optional[List[Pixel]] = Field(default=None, min_length=1, max_length=64)
    label: Optional[constr(max_length=180)] = None
    turn: Optional[Angle] = None
    tilt: Optional[Angle] = None
    forward: Optional[Move] = None
    strafe: Optional[Move] = None
    rise: Optional[Move] = None

    @property
    def moves(self) -> bool:
        return any(value for value in (self.turn, self.tilt, self.forward, self.strafe, self.rise))
