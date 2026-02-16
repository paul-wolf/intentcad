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


class OrganisationCreateSchema(Schema):
    name: str
    slug: str
    description: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""


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
