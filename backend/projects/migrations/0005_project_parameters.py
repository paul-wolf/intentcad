from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('projects', '0004_project_context'),
    ]

    operations = [
        migrations.AddField(
            model_name='project',
            name='parameters',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
