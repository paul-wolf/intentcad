# build123d — the model is this script. `part` is what gets built.
P = dict(plate=60, thick=20, boss_d=24, boss_h=24, bore_d=14, bolt_d=5,
         tilt=15, lean_dir=45, drop=40, spin=0, hole_rot=90, boss_spin=45,
         channel_d=30,
         mount_d=3, mount_edge_y=8, mount_edge_x=10, mount_depth=20)

part = Pos(0, 0, P["thick"]/2) * Box(P["plate"], P["plate"], P["thick"])

# aim the lean toward a corner (lean_dir), tilt the socket over about its base,
# then spin it about its own axis
tilt = (Pos(0, 0, P["thick"]) * Rot(0, 0, P["lean_dir"])
        * Rot(P["tilt"], 0, 0) * Rot(0, 0, P["boss_spin"]))

# a socket (tube): rises boss_h above the plate and drops down past the bottom
L = P["boss_h"] + P["drop"]
zc = (P["boss_h"] - P["drop"]) / 2
part += tilt * Pos(0, 0, zc) * (Cylinder(P["boss_d"]/2, L)
                                - Cylinder(P["bore_d"]/2, L))

# retaining cross-hole through the socket wall (kept at original height)
part -= tilt * Pos(0, 0, P["boss_h"]/2) * Rot(0, 0, P["hole_rot"]) * Rot(90, 0, 0) * Cylinder(P["bolt_d"]/2, P["boss_d"]*2)

# trim the boss flush with the bottom plane (z = 0), so it never exceeds it
part -= Pos(0, 0, -P["drop"]) * Box(P["plate"]*4, P["plate"]*4, P["drop"]*2)

# half-pipe channel: bore centered on the bottom plane (z=0), running along the Y axis
part -= Pos(0, 0, 0) * Rot(90, 0, 0) * Cylinder(P["channel_d"]/2, P["plate"]*2)

# four M3 mounting holes bored into the bottom face (z=0), drilling upward.
# spread further out along x (smaller mount_edge_y) so they clear the half-pipe channel
hx = P["plate"]/2 - P["mount_edge_y"]
hy = P["plate"]/2 - P["mount_edge_x"]
for sx in (-1, 1):
    for sy in (-1, 1):
        part -= Pos(sx*hx, sy*hy, P["mount_depth"]/2) * Cylinder(P["mount_d"]/2, P["mount_depth"])

# spin the whole part about Z
part = Rot(0, 0, P["spin"]) * part
