from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.middleware.csrf import get_token
from ninja import Router

from .models import LoginLog, Organisation, User
from .schemas import (
    ChangePasswordSchema,
    CreateUserSchema,
    CSRFTokenSchema,
    LoginResponseSchema,
    LoginSchema,
    MessageSchema,
    OrganisationCreateSchema,
    OrganisationDetailSchema,
    OrganisationSchema,
    OrganisationUpdateSchema,
    PasswordResetSchema,
    UpdateMeSchema,
    UpdateUserSchema,
    UserDetailSchema,
    UserSchema,
)

router = Router()


def get_client_ip(request):
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")


def organisation_to_schema(org):
    return OrganisationSchema(id=str(org.id), name=org.name, slug=org.slug)


def user_to_schema(user):
    return UserSchema(
        id=str(user.id),
        username=user.username,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        is_staff=user.is_staff,
        is_superuser=user.is_superuser,
        organisation=organisation_to_schema(user.organisation)
        if user.organisation
        else None,
        date_joined=user.date_joined.isoformat() if user.date_joined else None,
        last_login=user.last_login.isoformat() if user.last_login else None,
    )


def user_to_detail_schema(user):
    return UserDetailSchema(
        id=str(user.id),
        username=user.username,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        is_active=user.is_active,
        is_staff=user.is_staff,
        is_superuser=user.is_superuser,
        date_joined=user.date_joined.isoformat(),
        last_login=user.last_login.isoformat() if user.last_login else None,
        failed_login_attempts=user.failed_login_attempts,
        locked_until=user.locked_until.isoformat() if user.locked_until else None,
        organisation=organisation_to_schema(user.organisation)
        if user.organisation
        else None,
    )


def _require_staff_or_superuser(request):
    """Return error response if user is not staff or superuser, else None."""
    if not request.user.is_authenticated:
        return 401, {"message": "Authentication required"}
    if not request.user.is_staff and not request.user.is_superuser:
        return 403, {"message": "Staff access required"}
    return None


def _scoped_users(request):
    """Return users queryset scoped by caller's permissions."""
    qs = User.objects.select_related("organisation").order_by("-date_joined")
    if request.user.is_superuser:
        return qs
    # Staff: only users in their own org
    return qs.filter(organisation_id=request.user.organisation_id)


# ── Public auth endpoints ──


@router.get("/csrf", response=CSRFTokenSchema)
def get_csrf_token(request):
    return {"csrfToken": get_token(request)}


@router.post(
    "/login",
    response={200: LoginResponseSchema, 401: MessageSchema, 403: MessageSchema},
)
def login_user(request, credentials: LoginSchema):
    ip_address = get_client_ip(request)
    user_agent = request.META.get("HTTP_USER_AGENT", "")[:500]

    try:
        if "@" in credentials.username:
            existing_user = User.objects.get(email=credentials.username)
        else:
            existing_user = User.objects.get(username=credentials.username)
    except User.DoesNotExist:
        return 401, {"message": "Invalid credentials"}

    if existing_user.is_locked():
        from django.utils import timezone

        remaining = int(
            (existing_user.locked_until - timezone.now()).total_seconds() // 60
        )
        return 403, {
            "message": f"Account locked. Try again in {remaining} minutes."
        }

    user = authenticate(
        request, username=existing_user.username, password=credentials.password
    )

    if user is None:
        existing_user.record_failed_login()
        LoginLog.objects.create(
            user=existing_user,
            ip_address=ip_address,
            user_agent=user_agent,
            success=False,
        )
        return 401, {"message": "Invalid credentials"}

    user.clear_failed_logins()
    LoginLog.objects.create(
        user=user,
        ip_address=ip_address,
        user_agent=user_agent,
        success=True,
    )
    login(request, user)
    return 200, {"user": user_to_schema(user), "message": "Login successful"}


@router.post("/logout", response=MessageSchema)
def logout_user(request):
    logout(request)
    return {"message": "Logged out successfully"}


@router.get("/me", response={200: UserSchema, 401: MessageSchema})
def get_current_user(request):
    if not request.user.is_authenticated:
        return 401, {"message": "Not authenticated"}
    return 200, user_to_schema(request.user)


@router.patch(
    "/me",
    response={200: UserSchema, 400: MessageSchema, 401: MessageSchema},
)
def update_current_user(request, data: UpdateMeSchema):
    if not request.user.is_authenticated:
        return 401, {"message": "Not authenticated"}

    user = request.user

    if data.email is not None:
        if User.objects.filter(email=data.email).exclude(id=user.id).exists():
            return 400, {"message": "Email already exists"}
        user.email = data.email

    if data.first_name is not None:
        user.first_name = data.first_name
    if data.last_name is not None:
        user.last_name = data.last_name

    user.save()
    return 200, user_to_schema(user)


@router.post(
    "/me/change-password",
    response={200: MessageSchema, 400: MessageSchema, 401: MessageSchema},
)
def change_password(request, data: ChangePasswordSchema):
    if not request.user.is_authenticated:
        return 401, {"message": "Not authenticated"}
    user = request.user
    if not user.check_password(data.current_password):
        return 400, {"message": "Current password is incorrect"}
    if len(data.new_password) < 8:
        return 400, {"message": "Password must be at least 8 characters"}
    user.set_password(data.new_password)
    user.save()
    from django.contrib.auth import update_session_auth_hash
    update_session_auth_hash(request, user)  # keep the current session signed in
    return 200, {"message": "Password updated"}


# ── Password reset (token-based, no email) ──


@router.post(
    "/password-reset",
    response={200: MessageSchema, 400: MessageSchema},
)
def reset_password(request, data: PasswordResetSchema):
    if len(data.password) < 8:
        return 400, {"message": "Password must be at least 8 characters"}

    try:
        user = User.objects.get(password_reset_token=data.token)
    except User.DoesNotExist:
        return 400, {"message": "Invalid or expired token"}

    if not user.is_password_reset_valid(data.token):
        return 400, {"message": "Invalid or expired token"}

    user.set_password(data.password)
    user.password_reset_token = ""
    user.password_reset_sent_at = None
    user.save()
    user.clear_failed_logins()

    return 200, {"message": "Password has been reset successfully"}


# ── User management (staff or superuser) ──


@router.get(
    "/manage/users",
    response={200: list[UserDetailSchema], 401: MessageSchema, 403: MessageSchema},
)
def list_users(request):
    err = _require_staff_or_superuser(request)
    if err:
        return err
    return 200, [user_to_detail_schema(u) for u in _scoped_users(request)]


@router.get(
    "/manage/users/{user_id}",
    response={
        200: UserDetailSchema,
        401: MessageSchema,
        403: MessageSchema,
        404: MessageSchema,
    },
)
def get_user(request, user_id: str):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    try:
        user = User.objects.select_related("organisation").get(id=user_id)
    except User.DoesNotExist:
        return 404, {"message": "User not found"}

    # Staff can only view users in their own org
    if not request.user.is_superuser and user.organisation_id != request.user.organisation_id:
        return 404, {"message": "User not found"}

    return 200, user_to_detail_schema(user)


@router.post(
    "/manage/users",
    response={
        201: UserDetailSchema,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
    },
)
def create_user(request, data: CreateUserSchema):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    if User.objects.filter(username=data.username).exists():
        return 400, {"message": "Username already exists"}
    if User.objects.filter(email=data.email).exists():
        return 400, {"message": "Email already exists"}

    # Staff cannot set is_superuser
    if not request.user.is_superuser and data.is_superuser:
        return 403, {"message": "Only superusers can grant superuser status"}

    # Staff must create users in their own org
    org = None
    if request.user.is_superuser:
        if data.organisation_id:
            try:
                org = Organisation.objects.get(id=data.organisation_id)
            except Organisation.DoesNotExist:
                return 400, {"message": "Organisation not found"}
    else:
        # Staff: force org to their own
        org = request.user.organisation

    user = User.objects.create_user(
        username=data.username,
        email=data.email,
        password=None,
        first_name=data.first_name,
        last_name=data.last_name,
        is_staff=data.is_staff,
        is_superuser=data.is_superuser if request.user.is_superuser else False,
    )
    user.set_unusable_password()
    user.organisation = org
    user.save()
    return 201, user_to_detail_schema(user)


@router.patch(
    "/manage/users/{user_id}",
    response={
        200: UserDetailSchema,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
        404: MessageSchema,
    },
)
def update_user(request, user_id: str, data: UpdateUserSchema):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 404, {"message": "User not found"}

    # Staff can only edit users in their own org
    if not request.user.is_superuser and user.organisation_id != request.user.organisation_id:
        return 404, {"message": "User not found"}

    if user.id == request.user.id and data.is_superuser is False:
        return 400, {"message": "Cannot remove your own superuser status"}

    # Staff cannot change is_superuser or organisation
    if not request.user.is_superuser:
        if data.is_superuser is not None:
            return 403, {"message": "Only superusers can change superuser status"}
        if data.organisation_id is not None:
            return 403, {"message": "Only superusers can change user organisation"}

    if data.email is not None:
        if User.objects.filter(email=data.email).exclude(id=user_id).exists():
            return 400, {"message": "Email already exists"}
        user.email = data.email

    if data.first_name is not None:
        user.first_name = data.first_name
    if data.last_name is not None:
        user.last_name = data.last_name

    if data.organisation_id is not None:
        if data.organisation_id == "":
            user.organisation = None
        else:
            try:
                org = Organisation.objects.get(id=data.organisation_id)
                user.organisation = org
            except Organisation.DoesNotExist:
                return 400, {"message": "Organisation not found"}

    if data.is_active is not None:
        user.is_active = data.is_active
    if data.is_staff is not None:
        user.is_staff = data.is_staff
    if data.is_superuser is not None:
        user.is_superuser = data.is_superuser

    user.save()
    return 200, user_to_detail_schema(user)


@router.delete(
    "/manage/users/{user_id}",
    response={
        204: None,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
        404: MessageSchema,
    },
)
def delete_user(request, user_id: str):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 404, {"message": "User not found"}

    # Staff can only delete users in their own org
    if not request.user.is_superuser and user.organisation_id != request.user.organisation_id:
        return 404, {"message": "User not found"}

    if user.id == request.user.id:
        return 400, {"message": "Cannot delete your own account"}

    user.delete()
    return 204, None


@router.post(
    "/manage/users/{user_id}/unlock",
    response={200: MessageSchema, 401: MessageSchema, 403: MessageSchema, 404: MessageSchema},
)
def unlock_user(request, user_id: str):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 404, {"message": "User not found"}

    if not request.user.is_superuser and user.organisation_id != request.user.organisation_id:
        return 404, {"message": "User not found"}

    user.clear_failed_logins()
    return 200, {"message": "User account unlocked"}


@router.post(
    "/manage/users/{user_id}/reset-link",
    response={200: dict, 401: MessageSchema, 403: MessageSchema, 404: MessageSchema},
)
def generate_reset_link(request, user_id: str):
    err = _require_staff_or_superuser(request)
    if err:
        return err

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 404, {"message": "User not found"}

    if not request.user.is_superuser and user.organisation_id != request.user.organisation_id:
        return 404, {"message": "User not found"}

    token = user.generate_password_reset_token()
    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:5951")
    reset_url = f"{frontend_url}/reset-password?token={token}"

    return {
        "token": token,
        "reset_url": reset_url,
        "expires_at": user.password_reset_sent_at.isoformat()
        if user.password_reset_sent_at
        else None,
    }


# ── Organisation management (superuser only) ──


@router.get(
    "/manage/organisations",
    response={200: list[OrganisationDetailSchema], 401: MessageSchema, 403: MessageSchema},
)
def list_organisations(request):
    if not request.user.is_authenticated:
        return 401, {"message": "Authentication required"}
    if not request.user.is_superuser:
        return 403, {"message": "Superuser access required"}

    orgs = Organisation.objects.all().order_by("name")
    result = []
    for org in orgs:
        result.append(
            OrganisationDetailSchema(
                id=str(org.id),
                name=org.name,
                slug=org.slug,
                description=org.description,
                email=org.email,
                phone=org.phone,
                website=org.website,
                is_active=org.is_active,
                user_count=org.users.count(),
            )
        )
    return 200, result


@router.post(
    "/manage/organisations",
    response={
        201: OrganisationDetailSchema,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
    },
)
def create_organisation(request, data: OrganisationCreateSchema):
    if not request.user.is_authenticated:
        return 401, {"message": "Authentication required"}
    if not request.user.is_superuser:
        return 403, {"message": "Superuser access required"}

    if Organisation.objects.filter(slug=data.slug).exists():
        return 400, {"message": "Slug already exists"}

    org = Organisation.objects.create(
        name=data.name,
        slug=data.slug,
        description=data.description,
        email=data.email,
        phone=data.phone,
        website=data.website,
    )
    return 201, OrganisationDetailSchema(
        id=str(org.id),
        name=org.name,
        slug=org.slug,
        description=org.description,
        email=org.email,
        phone=org.phone,
        website=org.website,
        is_active=org.is_active,
        user_count=0,
    )


@router.patch(
    "/manage/organisations/{org_id}",
    response={
        200: OrganisationDetailSchema,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
        404: MessageSchema,
    },
)
def update_organisation(request, org_id: str, data: OrganisationUpdateSchema):
    if not request.user.is_authenticated:
        return 401, {"message": "Authentication required"}
    if not request.user.is_superuser:
        return 403, {"message": "Superuser access required"}

    try:
        org = Organisation.objects.get(id=org_id)
    except Organisation.DoesNotExist:
        return 404, {"message": "Organisation not found"}

    if data.slug is not None:
        if Organisation.objects.filter(slug=data.slug).exclude(id=org_id).exists():
            return 400, {"message": "Slug already exists"}
        org.slug = data.slug

    if data.name is not None:
        org.name = data.name
    if data.description is not None:
        org.description = data.description
    if data.email is not None:
        org.email = data.email
    if data.phone is not None:
        org.phone = data.phone
    if data.website is not None:
        org.website = data.website
    if data.is_active is not None:
        org.is_active = data.is_active

    org.save()
    return 200, OrganisationDetailSchema(
        id=str(org.id),
        name=org.name,
        slug=org.slug,
        description=org.description,
        email=org.email,
        phone=org.phone,
        website=org.website,
        is_active=org.is_active,
        user_count=org.users.count(),
    )


@router.delete(
    "/manage/organisations/{org_id}",
    response={
        204: None,
        400: MessageSchema,
        401: MessageSchema,
        403: MessageSchema,
        404: MessageSchema,
    },
)
def delete_organisation(request, org_id: str):
    if not request.user.is_authenticated:
        return 401, {"message": "Authentication required"}
    if not request.user.is_superuser:
        return 403, {"message": "Superuser access required"}

    try:
        org = Organisation.objects.get(id=org_id)
    except Organisation.DoesNotExist:
        return 404, {"message": "Organisation not found"}

    if org.users.exists():
        return 400, {"message": "Cannot delete organisation with users"}

    org.delete()
    return 204, None
