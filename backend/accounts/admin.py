from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import LoginLog, Organisation, User, UserEvent


@admin.register(Organisation)
class OrganisationAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "is_active", "created_at")
    search_fields = ("name", "slug")


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("username", "email", "organisation", "is_staff", "is_active")
    list_filter = ("is_staff", "is_superuser", "is_active", "organisation")
    fieldsets = BaseUserAdmin.fieldsets + (
        ("Organisation", {"fields": ("organisation",)}),
        (
            "Security",
            {"fields": ("failed_login_attempts", "locked_until")},
        ),
    )


@admin.register(LoginLog)
class LoginLogAdmin(admin.ModelAdmin):
    list_display = ("user", "login_at", "ip_address", "success")
    list_filter = ("success",)
    readonly_fields = ("user", "login_at", "ip_address", "user_agent", "success")


@admin.register(UserEvent)
class UserEventAdmin(admin.ModelAdmin):
    list_display = ("created_at", "kind", "user_email", "document_name", "cost_usd")
    list_filter = ("kind",)
    search_fields = ("user_email", "document_name", "text")
    readonly_fields = [f.name for f in UserEvent._meta.fields]

    def has_add_permission(self, request):
        return False
