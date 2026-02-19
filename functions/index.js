const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { startOfDay, endOfDay, addDays, subMonths, subDays } = require("date-fns");

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();
const messaging = admin.messaging();

async function esAdministrador(uid) {
    if (!uid) return false;
    try {
        const doc = await db.collection('Admin').where('uidClient', '==', uid).get();
        return !doc.empty;
    } catch (e) {
        return false;
    }
}

async function borrarImagenStorage(url) {
    if (!url) return;
    try {
        const fileRef = storage.bucket().file(url); 
        await fileRef.delete();
    } catch (error) {
        console.warn(`No se pudo borrar la imagen ${url}:`, error.message);
    }
}

async function guardarNotificacion(uid, titulo, tipo, mensaje, imagen = null) {
    try {
        return await db.collection('Notificaciones').add({
            uid_usuario: uid,
            titulo,
            tipo,
            mensaje,
            imagen,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        console.error("Error guardando notificación db:", e);
    }
}

const validarTipo = (valor, tipo, nombreCampo) => {
    if (tipo === 'array') {
        if (!Array.isArray(valor)) throw new functions.https.HttpsError('invalid-argument', `El campo ${nombreCampo} debe ser una lista.`);
    } else if (typeof valor !== tipo) {
        throw new functions.https.HttpsError('invalid-argument', `El campo ${nombreCampo} debe ser ${tipo}.`);
    }
};


exports.crearEscenario = functions.https.onCall(async (data, context) => {
    try {
        if (!(await esAdministrador(context.auth?.uid))) {
            throw new functions.https.HttpsError('permission-denied', 'Solo administradores pueden crear escenarios.');
        }

        validarTipo(data.nombre, 'string', 'nombre');
        validarTipo(data.categoria, 'string', 'categoria');
        validarTipo(data.especial, 'boolean', 'especial');

        const { nombre, categoria, sub_categoria, descripcion, especial, tiempo_sesion, lleva_traje, img_principal, list_img } = data;

        return await db.collection('Escenarios').add({
            nombre,
            categoria,
            sub_categoria: sub_categoria || "",
            descripcion: descripcion || "",
            especial: especial || false,
            tiempo_sesion: especial ? null : (Number(tiempo_sesion) || 0),
            lleva_traje: lleva_traje || false,
            img_principal: img_principal || "",
            list_img: Array.isArray(list_img) ? list_img.slice(0, 5) : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        throw new functions.https.HttpsError(error.code || 'internal', error.message);
    }
});

exports.actualizarEscenario = functions.https.onCall(async (data, context) => {
    try {
        if (!(await esAdministrador(context.auth?.uid))) {
            throw new functions.https.HttpsError('permission-denied', 'No tienes permisos.');
        }

        const { id, ...campos } = data;
        if (!id) throw new functions.https.HttpsError('invalid-argument', 'Falta el ID del escenario.');

        const docRef = db.collection('Escenarios').doc(id);
        const docSnap = await docRef.get();
        if (!docSnap.exists) throw new functions.https.HttpsError('not-found', 'Escenario no encontrado');
        
        const oldData = docSnap.data();

        if (campos.img_principal && oldData.img_principal !== campos.img_principal) {
            await borrarImagenStorage(oldData.img_principal);
        }

        if (oldData.list_img && campos.list_img) {
            const eliminar = oldData.list_img.filter(img => !campos.list_img.includes(img));
            for (const img of eliminar) await borrarImagenStorage(img);
        }

        await docRef.update({
            ...campos,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError(error.code || 'internal', error.message);
    }
});

exports.eliminarEscenario = functions.https.onCall(async (data, context) => {
    try {
        if (!(await esAdministrador(context.auth?.uid))) {
            throw new functions.https.HttpsError('permission-denied', 'Solo administradores.');
        }

        const { id } = data;
        const docRef = db.collection('Escenarios').doc(id);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return { success: true };
        
        const escenario = docSnap.data();

        if (escenario.img_principal) await borrarImagenStorage(escenario.img_principal);
        if (escenario.list_img) {
            for (const img of escenario.list_img) await borrarImagenStorage(img);
        }

        await docRef.delete();
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.consultarEscenarios = functions.https.onCall(async (data, context) => {
    try {
        const { limit = 20, lastDocId, terminoBusqueda, categoria, sub_categoria } = data;
        let query = db.collection('Escenarios');

        if (categoria) query = query.where('categoria', '==', categoria);
        if (sub_categoria) query = query.where('sub_categoria', '==', sub_categoria);
        
        if (terminoBusqueda) {
            query = query.where('nombre', '>=', terminoBusqueda)
                         .where('nombre', '<=', terminoBusqueda + '\uf8ff');
        } else {
            query = query.orderBy('createdAt', 'desc');
        }

        if (lastDocId) {
            const lastDoc = await db.collection('Escenarios').doc(lastDocId).get();
            if (lastDoc.exists) query = query.startAfter(lastDoc);
        }

        const snap = await query.limit(limit).get();
        return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.crearCita = functions.https.onCall(async (data, context) => {
    try {
        if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión');
        const uid = context.auth.uid;

        validarTipo(data.fecha, 'string', 'fecha');
        
        const fechaCita = new Date(data.fecha); 
        const unMesAtras = subMonths(new Date(), 1);

        // Regla: Bloqueo por cancelaciones frecuentes
        const rechazosSnap = await db.collection('Citas')
            .where('uid_cliente', '==', uid)
            .where('estado_solicitud', '==', 'rechazada')
            .where('createdAt', '>=', unMesAtras)
            .get();

        if (rechazosSnap.size >= 2) {
            throw new functions.https.HttpsError('failed-precondition', 'Citas bloqueadas por cancelaciones frecuentes en el último mes.');
        }

        const inicioDia = startOfDay(fechaCita);
        const finDia = endOfDay(fechaCita);
        const citasHoySnap = await db.collection('Citas')
            .where('uid_cliente', '==', uid)
            .where('fecha', '>=', inicioDia)
            .where('fecha', '<=', finDia)
            .get();

        if (!citasHoySnap.empty) {
            throw new functions.https.HttpsError('already-exists', 'Ya tienes una cita programada para este día.');
        }

        const nuevaCita = {
            ...data,
            uid_cliente: uid,
            fecha: admin.firestore.Timestamp.fromDate(fechaCita),
            estado_solicitud: 'espera',
            estado_atendida: 'espera',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        return await db.collection('Citas').add(nuevaCita);
    } catch (error) {
        throw new functions.https.HttpsError(error.code || 'internal', error.message);
    }
});

exports.actualizarCita = functions.https.onCall(async (data, context) => {
    try {
        const { id, ...campos } = data;
        const uid = context.auth.uid;
        if (!uid) throw new functions.https.HttpsError('unauthenticated', 'No logueado');

        const isAdmin = await esAdministrador(uid);
        const citaRef = db.collection('Citas').doc(id);
        const citaSnap = await citaRef.get();
        
        if(!citaSnap.exists) throw new functions.https.HttpsError('not-found', 'Cita no encontrada');
        const citaData = citaSnap.data();

        if (isAdmin) {
            await citaRef.update({
                ...campos,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            if (citaData.uid_cliente !== uid) {
                throw new functions.https.HttpsError('permission-denied', 'No tienes permiso sobre esta cita.');
            }
            // El cliente solo puede cancelar (pasar a rechazada)
            if (Object.keys(campos).length === 1 && campos.estado_solicitud === 'rechazada') {
                 await citaRef.update({
                    estado_solicitud: 'rechazada',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                throw new functions.https.HttpsError('permission-denied', 'Los clientes solo pueden cancelar su cita.');
            }
        }
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.consultarCitas = functions.https.onCall(async (data, context) => {
    try {
        const uid = context.auth.uid;
        if (!uid) throw new functions.https.HttpsError('unauthenticated', 'No logueado');

        const isAdmin = await esAdministrador(uid);
        const { uid_cliente_consulta, fecha, limit = 20, lastDocId } = data;

        let query = db.collection('Citas');

        if (isAdmin) {
            if (fecha) {
                const d = new Date(fecha);
                query = query.where('fecha', '>=', startOfDay(d))
                             .where('fecha', '<=', endOfDay(d));
            } else if (uid_cliente_consulta) {
                query = query.where('uid_cliente', '==', uid_cliente_consulta);
            }
        } else {
            query = query.where('uid_cliente', '==', uid)
                         .where('estado_solicitud', '!=', 'rechazada');
        }

        query = query.orderBy('fecha', 'asc');

        if (limit) query = query.limit(limit);
        if (lastDocId) {
            const lastDoc = await db.collection('Citas').doc(lastDocId).get();
            if (lastDoc.exists) query = query.startAfter(lastDoc);
        }

        const snap = await query.get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.crearOActualizarCliente = functions.https.onCall(async (data, context) => {
    try {
        const { provider, providerUserId, name, email, photo } = data;
        const uid = context.auth.uid;
        if (!uid) throw new functions.https.HttpsError('unauthenticated', 'No logueado');

        await db.collection('Clientes').doc(uid).set({
            provider: provider || "",
            providerUserId: providerUserId || "",
            name: name || "Sin nombre",
            email: email || "",
            photo: photo || "",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.eliminarCliente = functions.https.onCall(async (data, context) => {
    try {
        const { uid_a_eliminar } = data;
        const uid_solicitante = context.auth.uid;
        const isAdmin = await esAdministrador(uid_solicitante);

        if (uid_a_eliminar !== uid_solicitante && !isAdmin) {
            throw new functions.https.HttpsError('permission-denied', 'No autorizado para eliminar este perfil.');
        }

        await db.collection('Clientes').doc(uid_a_eliminar).delete();
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.consultarClientes = functions.https.onCall(async (data, context) => {
    try {
        if (!(await esAdministrador(context.auth?.uid))) throw new functions.https.HttpsError('permission-denied', 'Acceso denegado.');
        
        const { busqueda, limit = 20, lastDocId } = data;
        let query = db.collection('Clientes');

        if (busqueda) {
            query = query.orderBy('name').startAt(busqueda).endAt(busqueda + '\uf8ff');
        } else {
            query = query.orderBy('createdAt', 'desc');
        }

        if (lastDocId) {
            const doc = await db.collection('Clientes').doc(lastDocId).get();
            if (doc.exists) query = query.startAfter(doc);
        }

        const snap = await query.limit(limit).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.registrarDispositivo = functions.https.onCall(async (data, context) => {
    try {
        const { token_fcm, uid_dispositivo, plataforma } = data;
        const uid_usuario = context.auth ? context.auth.uid : null;

        await db.collection('Dispositivos').doc(uid_dispositivo).set({
            uid_usuario,
            token_fcm,
            plataforma,
            activo: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.crearSolicitudFotos = functions.https.onCall(async (data, context) => {
    try {
        const uid = context.auth.uid;
        if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Inicie sesión.');

        return await db.collection('Solicitudes_Fotos').add({
            uid_cliente: uid,
            recibo_url: data.recibo_url || "",
            estado: 'pendiente',
            fotos_urls: [],
            fecha_solicitud: admin.firestore.FieldValue.serverTimestamp(),
            fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.actualizarSolicitudAdmin = functions.https.onCall(async (data, context) => {
    try {
        if (!(await esAdministrador(context.auth?.uid))) throw new functions.https.HttpsError('permission-denied', 'Solo admin.');

        const { id, fotos_urls } = data;
        await db.collection('Solicitudes_Fotos').doc(id).update({
            fotos_urls: fotos_urls || [],
            estado: 'entregado',
            fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.eliminarSolicitud = functions.https.onCall(async (data, context) => {
    try {
        const { id } = data;
        const uid = context.auth.uid;
        const isAdmin = await esAdministrador(uid);

        const docRef = db.collection('Solicitudes_Fotos').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) return { success: true };
        const solicitud = doc.data();

        if (solicitud.uid_cliente !== uid && !isAdmin) {
            throw new functions.https.HttpsError('permission-denied', 'No autorizado.');
        }

        await docRef.delete();
        return { success: true };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.notificarCambioCita = functions.firestore
    .document('Citas/{citaId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();

        if (newData.estado_solicitud === oldData.estado_solicitud) return null;

        const uid = newData.uid_cliente;
        const titulo = newData.escenario_nombre || "Cita";
        const tipo = 'Confirmación';
        let mensaje = '';
        
        if (newData.estado_solicitud === 'aceptada') {
            mensaje = `Tu cita para ${titulo} ha sido confirmada.`;
        } else if (newData.estado_solicitud === 'rechazada') {
            mensaje = `Tu cita para ${titulo} ha sido rechazada.`;
        } else {
            return null;
        }

        const imagen = newData.escenario_img_principal;
        await guardarNotificacion(uid, titulo, tipo, mensaje, imagen);

        const devices = await db.collection('Dispositivos')
            .where('uid_usuario', '==', uid)
            .where('activo', '==', true)
            .get();
        
        const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);

        if (tokens.length > 0) {
            await messaging.sendEachForMulticast({
                tokens,
                notification: { title: titulo, body: mensaje, image: imagen || "" }
            });
        }
        return null;
    });

exports.notificarNuevoEscenario = functions.firestore
    .document('Escenarios/{escenarioId}')
    .onCreate(async (snap, context) => {
        const escenario = snap.data();
        const devices = await db.collection('Dispositivos').where('activo', '==', true).get();
        const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);

        const payload = {
            notification: {
                title: '¡Nuevo Escenario!',
                body: `Ven a conocer "${escenario.nombre}"`,
                image: escenario.img_principal || ""
            }
        };

        const batchSize = 500;
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batchTokens = tokens.slice(i, i + batchSize);
            await messaging.sendEachForMulticast({
                tokens: batchTokens,
                ...payload
            });
        }
        return null;
    });

exports.notificarFotosListas = functions.firestore
    .document('Solicitudes_Fotos/{solicitudId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();

        if (newData.estado === 'entregado' && oldData.estado !== 'entregado') {
             const uid = newData.uid_cliente;
             const msg = "Tus fotos ya están disponibles en la app.";
             
             await guardarNotificacion(uid, "Fotos Listas", "Info", msg);

             const devices = await db.collection('Dispositivos').where('uid_usuario', '==', uid).get();
             const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);
             
             if (tokens.length > 0) {
                 await messaging.sendEachForMulticast({
                     tokens,
                     notification: { title: "Fotos Listas", body: msg }
                 });
             }
        }
        return null;
    });

exports.recordatorioDiario = functions.pubsub.schedule('0 9 * * *')
    .timeZone('America/Bogota') 
    .onRun(async (context) => {
        const hoy = startOfDay(new Date());
        const limite = endOfDay(addDays(hoy, 2));

        const citasSnap = await db.collection('Citas')
            .where('fecha', '>=', hoy)
            .where('fecha', '<=', limite)
            .where('estado_solicitud', '==', 'aceptada')
            .get();

        for (const doc of citasSnap.docs) {
            const cita = doc.data();
            const uid = cita.uid_cliente;
            const escenario = cita.escenario_nombre;

            const devices = await db.collection('Dispositivos').where('uid_usuario', '==', uid).get();
            const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);
            
            if (tokens.length > 0) {
                const bodyMsg = `Recuerda tu cita próxima en ${escenario}`;
                await messaging.sendEachForMulticast({
                    tokens,
                    notification: {
                        title: "Recordatorio de Cita",
                        body: bodyMsg
                    }
                });
                await guardarNotificacion(uid, "Recordatorio", "recordatorio", bodyMsg);
            }
        }
        console.log('Recordatorios enviados con éxito.');
        return null;
    });
