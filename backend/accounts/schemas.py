from ninja import Schema


class LoginSchema(Schema):
    username: str
    password: str


class OrganisationSchema(Schema):
    id: str
    name: str
    slug: str


class OrganisationDetailSchema(Schema):
    id: str
    name: str
    slug: str
    description: str
    email: str
    phone: str
    website: str
    is_active: bool
    user_count: int = 0
    examples_note: str | None = None   # on create: the examples added, or why not


class OrganisationCreateSchema(Schema):
    name: str
    slug: str
    description: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""
    add_examples: bool = True   # copy the examples project, if one is chosen


class ExampleProjectSchema(Schema):
    id: str
    name: str
    organisation: str
    document_count: int


class ExamplesSettingSchema(Schema):
    project: ExampleProjectSchema | None = None
    choices: list[ExampleProjectSchema]


class ExamplesSetSchema(Schema):
    project_id: str | None = None


class ExamplesAddedSchema(Schema):
    project_id: str
    name: str
    document_count: int
    message: str


class OrganisationUpdateSchema(Schema):
    name: str | None = None
    slug: str | None = None
    description: str | None = None
    email: str | None = None
    phone: str | None = None
    website: str | None = None
    is_active: bool | None = None


class UserSchema(Schema):
    id: str
    username: str
    email: str
    first_name: str
    last_name: str
    is_staff: bool
    is_superuser: bool
    organisation: OrganisationSchema | None = None
    date_joined: str | None = None
    last_login: str | None = None


class ChangePasswordSchema(Schema):
    current_password: str
    new_password: str


class UserDetailSchema(Schema):
    id: str
    username: str
    email: str
    first_name: str
    last_name: str
    is_active: bool
    is_staff: bool
    is_superuser: bool
    date_joined: str
    last_login: str | None
    failed_login_attempts: int
    locked_until: str | None
    organisation: OrganisationSchema | None = None


class LoginResponseSchema(Schema):
    user: UserSchema
    message: str = "Login successful"


class MessageSchema(Schema):
    message: str


class CSRFTokenSchema(Schema):
    csrfToken: str  # noqa: N815


class CreateUserSchema(Schema):
    username: str
    email: str
    first_name: str = ""
    last_name: str = ""
    organisation_id: str | None = None
    is_staff: bool = False
    is_superuser: bool = False


class UpdateUserSchema(Schema):
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    organisation_id: str | None = None
    is_active: bool | None = None
    is_staff: bool | None = None
    is_superuser: bool | None = None


class UpdateMeSchema(Schema):
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None


class PasswordResetSchema(Schema):
    token: str
    password: str


class UserEventSchema(Schema):
    id: int
    kind: str
    at: str
    user_id: str | None = None
    user_email: str
    user_name: str
    ip_address: str | None = None
    user_agent: str = ""
    document_id: str
    document_name: str
    document_kind: str
    text: str
    cost_usd: float
    detail: dict


class EventSpendSchema(Schema):
    cost_usd: float
    ai_calls: int


class UserEventTotalsSchema(Schema):
    user_id: str
    email: str
    name: str
    organisation: str
    ai_calls: int
    cost_usd: float
    logins: int
    documents_created: int
    last_at: str | None = None


class EventUserSchema(Schema):
    id: str
    email: str
    name: str


class UserEventListSchema(Schema):
    total: int
    events: list[UserEventSchema]
    spend: EventSpendSchema
    by_user: list[UserEventTotalsSchema]
    users: list[EventUserSchema]
